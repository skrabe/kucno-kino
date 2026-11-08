// kkproxy: a tiny Stremio stream add-on that runs on the TV box itself (127.0.0.1 only).
//
// Torrentio rate-limits requests coming from Cloudflare, so the box fetches its own Torrentio + Real-Debrid
// results over the home connection, then asks the Kućno kino worker (/u/<key>/curate) to turn ~75 raw torrent
// names into a short Croatian list. If the worker can't be reached, the raw Torrentio list is returned so
// playback never depends on it.
//
// Config (root-only JSON file): {"torrentio": "https://torrentio.strem.fun/<config>", "curate": "https://.../u/<key>/curate"}
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type config struct {
	Torrentio string `json:"torrentio"`
	Curate    string `json:"curate"`
}

var manifest = map[string]any{
	"id":          "hr.kucnokino.streams",
	"version":     "1.0.0",
	"name":        "Kućno kino · gledanje",
	"description": "Kratak popis izvora na hrvatskom (Torrentio + Real-Debrid), radi na samom TV boxu.",
	"resources":   []any{map[string]any{"name": "stream", "types": []string{"movie", "series"}, "idPrefixes": []string{"tt"}}},
	"types":       []string{"movie", "series"},
	"idPrefixes":  []string{"tt"},
	"catalogs":    []any{},
}

var streamPath = regexp.MustCompile(`^/stream/(movie|series)/(tt\d+(?::\d+:\d+)?)\.json$`)

type cacheEntry struct {
	body    []byte
	expires time.Time
}

type server struct {
	cfg    config
	client *http.Client
	mu     sync.Mutex
	cache  map[string]cacheEntry
}

func (s *server) get(url string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 10) Stremio")
		req.Header.Set("Accept", "application/json")
		res, err := s.client.Do(req)
		if err == nil {
			body, rerr := io.ReadAll(io.LimitReader(res.Body, 8<<20))
			res.Body.Close()
			if res.StatusCode == http.StatusOK && rerr == nil {
				return body, nil
			}
			err = fmt.Errorf("status %d", res.StatusCode)
		}
		lastErr = safeErr(err)
		time.Sleep(time.Second)
	}
	return nil, lastErr
}

func (s *server) curate(kind string, raw []byte) ([]byte, error) {
	res, err := s.client.Post(s.cfg.Curate+"?type="+kind, "application/json", bytes.NewReader(raw))
	if err != nil {
		return nil, safeErr(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil || res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("curate status %d: %v", res.StatusCode, err)
	}
	var check struct {
		Streams []json.RawMessage `json:"streams"`
	}
	if json.Unmarshal(body, &check) != nil || (len(check.Streams) == 0 && bytes.Contains(raw, []byte(`"url"`))) {
		return nil, fmt.Errorf("curate returned nothing usable")
	}
	return body, nil
}

func writeJSON(w http.ResponseWriter, body []byte, maxAge int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", fmt.Sprintf("max-age=%d", maxAge))
	w.Write(body)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	path := strings.ReplaceAll(r.URL.Path, "%3A", ":")
	if path == "/manifest.json" {
		body, _ := json.Marshal(manifest)
		writeJSON(w, body, 3600)
		return
	}
	if path == "/health" {
		writeJSON(w, []byte(`{"ok":true}`), 0)
		return
	}
	m := streamPath.FindStringSubmatch(path)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	kind, id := m[1], m[2]
	key := kind + "/" + id

	s.mu.Lock()
	if e, ok := s.cache[key]; ok && time.Now().Before(e.expires) {
		s.mu.Unlock()
		writeJSON(w, e.body, 600)
		return
	}
	s.mu.Unlock()

	raw, err := s.get(fmt.Sprintf("%s/stream/%s/%s.json", s.cfg.Torrentio, kind, id))
	if err != nil {
		log.Printf("torrentio %s: %v", key, err)
		writeJSON(w, []byte(`{"streams":[]}`), 0)
		return
	}
	body, err := s.curate(kind, raw)
	ttl := 10 * time.Minute
	if err != nil {
		log.Printf("curate %s: %v (serving raw Torrentio list)", key, err)
		body, ttl = raw, time.Minute
	}
	s.mu.Lock()
	if len(s.cache) > 500 {
		s.cache = map[string]cacheEntry{}
	}
	s.cache[key] = cacheEntry{body: body, expires: time.Now().Add(ttl)}
	s.mu.Unlock()
	writeJSON(w, body, int(ttl.Seconds()))
}

// androidRoots loads Android's system CA store; a linux/arm Go binary doesn't look there on its own.
func androidRoots() *x509.CertPool {
	pool := x509.NewCertPool()
	files, _ := filepath.Glob("/system/etc/security/cacerts/*")
	for _, f := range files {
		if pem, err := os.ReadFile(f); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}
	return pool
}

// safeErr drops the request URL from errors: the Torrentio URL contains the Real-Debrid key.
func safeErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// Android has no /etc/resolv.conf, so a static Go binary can't find a DNS server by itself.
// Use public resolvers directly (Cloudflare, then Google, then Quad9).
func httpClient() *http.Client {
	resolvers := []string{"1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"}
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 3 * time.Second}
			var lastErr error
			for _, r := range resolvers {
				c, err := d.DialContext(ctx, network, r)
				if err == nil {
					return c, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, Resolver: resolver}
	transport := &http.Transport{
		DialContext:         dialer.DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		TLSClientConfig:     &tls.Config{RootCAs: androidRoots()},
		MaxIdleConns:        8,
		IdleConnTimeout:     90 * time.Second,
	}
	return &http.Client{Timeout: 20 * time.Second, Transport: transport}
}

func main() {
	cfgPath := flag.String("config", "/data/kk/config.json", "config file")
	addr := flag.String("listen", "127.0.0.1:11471", "listen address")
	flag.Parse()
	data, err := os.ReadFile(*cfgPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.Torrentio == "" || cfg.Curate == "" {
		log.Fatalf("bad config: %v", err)
	}
	cfg.Torrentio = strings.TrimSuffix(strings.TrimSuffix(cfg.Torrentio, "/manifest.json"), "/")
	s := &server{cfg: cfg, client: httpClient(), cache: map[string]cacheEntry{}}
	log.Printf("kkproxy listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, s))
}
