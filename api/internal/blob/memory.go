package blob

import (
	"context"
	"slices"
	"strings"
	"sync"
)

type Memory struct {
	mu   sync.RWMutex
	objs map[string]memObj
}
type memObj struct {
	ct string
	b  []byte
}

func NewMemory() *Memory                         { return &Memory{objs: map[string]memObj{}} }
func (m *Memory) Ping(ctx context.Context) error { return nil }
func (m *Memory) Put(ctx context.Context, key, contentType string, body []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := append([]byte(nil), body...)
	m.objs[key] = memObj{ct: contentType, b: cp}
	return nil
}
func (m *Memory) Get(ctx context.Context, key string) ([]byte, string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	o, ok := m.objs[key]
	if !ok {
		return nil, "", ErrNotFound
	}
	return append([]byte(nil), o.b...), o.ct, nil
}
func (m *Memory) Delete(ctx context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objs, key)
	return nil
}
func (m *Memory) List(ctx context.Context, prefix string) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := []string{}
	for key := range m.objs {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	return keys, nil
}
