// Package middleware holds HTTP middleware. RateLimiter is a per-client
// token-bucket limiter: each client IP gets its own bucket that refills at a
// steady rate, so a burst is allowed but sustained flooding is rejected with
// 429. This complements the WebSocket layer's backpressure (bounded per-client
// send buffers) to protect the server end to end.
package middleware

import (
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type RateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	rate     rate.Limit
	burst    int
}

// NewRateLimiter allows `perSecond` sustained requests per client with a bucket
// of `burst`. A background sweep evicts idle clients so the map doesn't grow.
func NewRateLimiter(perSecond float64, burst int) *RateLimiter {
	rl := &RateLimiter{
		visitors: map[string]*visitor{},
		rate:     rate.Limit(perSecond),
		burst:    burst,
	}
	go rl.sweep()
	return rl
}

func (rl *RateLimiter) limiter(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	v, ok := rl.visitors[ip]
	if !ok {
		v = &visitor{limiter: rate.NewLimiter(rl.rate, rl.burst)}
		rl.visitors[ip] = v
	}
	v.lastSeen = time.Now()
	return v.limiter
}

func (rl *RateLimiter) sweep() {
	for range time.Tick(time.Minute) {
		rl.mu.Lock()
		for ip, v := range rl.visitors {
			if time.Since(v.lastSeen) > 3*time.Minute {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// Handler wraps next, rejecting requests from a client that has drained its
// bucket with 429 Too Many Requests.
func (rl *RateLimiter) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		if !rl.limiter(ip).Allow() {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate limit exceeded"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}
