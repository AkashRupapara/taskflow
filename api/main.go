// Phase 0 entrypoint: connect to Postgres, apply migrations, expose a health
// check. Domain routes (REST + WebSocket) are added in later phases.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"taskflow/internal/db"
	"taskflow/internal/middleware"
	"taskflow/internal/server"
	"taskflow/internal/store"
	"taskflow/internal/ws"
)

func main() {
	ctx := context.Background()

	dsn := env("DATABASE_URL", "postgres://taskflow:taskflow@localhost:5432/taskflow?sslmode=disable")
	port := env("PORT", "8080")

	// Postgres may still be starting (esp. under compose), so retry the connect.
	pool, err := connectWithRetry(ctx, dsn, 10)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Println("migrations applied")

	st := store.New(pool)

	// The hub broadcasts committed events; wiring it as the store's publisher is
	// what turns every REST mutation into a realtime update for subscribers.
	hub := ws.NewHub(st, log.Printf)
	st.SetPublisher(hub)

	// REST routes live in the server package; health + ws stay here.
	mux := server.New(st).Routes()
	mux.HandleFunc("GET /ws", hub.ServeHTTP)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := pool.Ping(r.Context()); err != nil {
			status = "degraded"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		writeJSON(w, map[string]string{"status": status})
	})

	// Per-IP token bucket: generous limits so normal use (incl. bulk snapshot
	// loads) is never hit, but a flood is rejected with 429.
	limiter := middleware.NewRateLimiter(100, 300)

	log.Printf("listening on :%s", port)
	if err := http.ListenAndServe(":"+port, withCORS(limiter.Handler(mux))); err != nil {
		log.Fatal(err)
	}
}

// connectWithRetry pings the pool until it succeeds or attempts run out.
func connectWithRetry(ctx context.Context, dsn string, attempts int) (*pgxpool.Pool, error) {
	var lastErr error
	for i := 0; i < attempts; i++ {
		pool, err := pgxpool.New(ctx, dsn)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		log.Printf("db not ready (attempt %d/%d): %v", i+1, attempts, err)
		time.Sleep(2 * time.Second)
	}
	return nil, lastErr
}

// withCORS allows the Vite dev server to call the API during development.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
