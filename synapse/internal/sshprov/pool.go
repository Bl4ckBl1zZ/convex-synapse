package sshprov

import (
	"context"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const defaultIdleTimeout = 5 * time.Minute

type connEntry struct {
	client   *ssh.Client
	lastUsed time.Time
}

type pool struct {
	loader      SignerLoader
	idleTimeout time.Duration
	// dial is a seam for tests; defaults to defaultDial.
	dial func(ctx context.Context, network, addr string, cfg *ssh.ClientConfig) (*ssh.Client, error)

	mu      sync.Mutex
	entries map[string]*connEntry
}

func newPool(loader SignerLoader, idleTimeout time.Duration) *pool {
	return &pool{
		loader:      loader,
		idleTimeout: idleTimeout,
		entries:     make(map[string]*connEntry),
		dial:        defaultDial,
	}
}

func defaultDial(ctx context.Context, network, addr string, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return ssh.NewClient(c, chans, reqs), nil
}

func (p *pool) key(t Target) string {
	return t.HostID + "|" + t.addr()
}

func (p *pool) get(ctx context.Context, t Target) (*ssh.Client, error) {
	key := p.key(t)
	p.mu.Lock()
	if entry, ok := p.entries[key]; ok {
		if time.Since(entry.lastUsed) < p.idleTimeout {
			entry.lastUsed = time.Now()
			c := entry.client
			p.mu.Unlock()
			return c, nil
		}
		// Idle too long — drop it.
		_ = entry.client.Close()
		delete(p.entries, key)
	}
	p.mu.Unlock()

	signer, err := p.loader(ctx, t.HostID)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            t.user(),
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	client, err := p.dial(ctx, "tcp", t.addr(), cfg)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	// Racing get() on the same host: keep the first connection, close ours.
	if existing, ok := p.entries[key]; ok && time.Since(existing.lastUsed) < p.idleTimeout {
		p.mu.Unlock()
		_ = client.Close()
		return existing.client, nil
	}
	p.entries[key] = &connEntry{client: client, lastUsed: time.Now()}
	p.mu.Unlock()
	return client, nil
}

func (p *pool) evict(t Target) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := p.key(t)
	if entry, ok := p.entries[key]; ok {
		_ = entry.client.Close()
		delete(p.entries, key)
	}
}

func (p *pool) closeAll() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var firstErr error
	for key, entry := range p.entries {
		if err := entry.client.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(p.entries, key)
	}
	return firstErr
}
