// Package server wires the REST routes to the store and maps domain errors to
// HTTP status codes. Realtime (WebSocket) routes are added in Phase 2.
package server

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"taskflow/internal/store"
)

//go:embed openapi.yaml
var openAPISpec []byte

type Server struct {
	store *store.Store
}

func New(s *store.Store) *Server { return &Server{store: s} }

// Routes registers every endpoint on a mux and returns it. Go 1.22+ pattern
// matching gives us method + path params without an external router.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/projects", s.listProjects)
	mux.HandleFunc("POST /api/projects", s.createProject)
	mux.HandleFunc("GET /api/projects/{id}", s.getProject)
	mux.HandleFunc("PATCH /api/projects/{id}", s.updateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", s.deleteProject)

	mux.HandleFunc("GET /api/projects/{id}/tasks", s.listTasks)
	mux.HandleFunc("POST /api/projects/{id}/tasks", s.createTask)
	mux.HandleFunc("PATCH /api/tasks/{id}", s.updateTask)
	mux.HandleFunc("DELETE /api/tasks/{id}", s.deleteTask)

	mux.HandleFunc("GET /api/tasks/{id}/comments", s.listComments)
	mux.HandleFunc("POST /api/tasks/{id}/comments", s.addComment)

	// Catch-up feed for reconnecting clients (Phase 2 uses this over WS).
	mux.HandleFunc("GET /api/projects/{id}/events", s.listEvents)

	// API documentation (OpenAPI 3.0 spec, embedded in the binary).
	mux.HandleFunc("GET /api/openapi.yaml", s.openAPI)

	return mux
}

func (s *Server) openAPI(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(openAPISpec)
}

// --- projects ---

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.store.ListProjects(r.Context())
	respond(w, projects, err)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var in store.ProjectInput
	if !decode(w, r, &in) {
		return
	}
	p, err := s.store.CreateProject(r.Context(), in)
	respondStatus(w, p, err, http.StatusCreated)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.GetProject(r.Context(), r.PathValue("id"))
	respond(w, p, err)
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	var in store.ProjectInput
	if !decode(w, r, &in) {
		return
	}
	p, err := s.store.UpdateProject(r.Context(), r.PathValue("id"), in)
	respond(w, p, err)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteProject(r.Context(), r.PathValue("id"))
	respondStatus(w, map[string]string{"status": "deleted"}, err, http.StatusOK)
}

// --- tasks ---

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := s.store.ListTasks(r.Context(), r.PathValue("id"), limit, r.URL.Query().Get("cursor"))
	respond(w, page, err)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var in store.TaskInput
	if !decode(w, r, &in) {
		return
	}
	t, err := s.store.CreateTask(r.Context(), r.PathValue("id"), in)
	respondStatus(w, t, err, http.StatusCreated)
}

func (s *Server) updateTask(w http.ResponseWriter, r *http.Request) {
	var patch store.TaskPatch
	if !decode(w, r, &patch) {
		return
	}
	t, err := s.store.UpdateTask(r.Context(), r.PathValue("id"), patch)
	respond(w, t, err)
}

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteTask(r.Context(), r.PathValue("id"))
	respondStatus(w, map[string]string{"status": "deleted"}, err, http.StatusOK)
}

// --- comments ---

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	comments, err := s.store.ListComments(r.Context(), r.PathValue("id"))
	respond(w, comments, err)
}

func (s *Server) addComment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Content string `json:"content"`
		Author  string `json:"author"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := s.store.AddComment(r.Context(), r.PathValue("id"), in.Content, in.Author)
	respondStatus(w, c, err, http.StatusCreated)
}

// --- events ---

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	events, err := s.store.ListEvents(r.Context(), r.PathValue("id"), since, limit)
	respond(w, events, err)
}

// --- helpers ---

// decode reads a JSON body; on failure it writes 400 and returns false.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func respond(w http.ResponseWriter, v any, err error) {
	respondStatus(w, v, err, http.StatusOK)
}

func respondStatus(w http.ResponseWriter, v any, err error, ok int) {
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(ok)
	_ = json.NewEncoder(w).Encode(v)
}

// statusFor maps store errors to HTTP codes.
func statusFor(err error) int {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, store.ErrInvalidStatus):
		return http.StatusBadRequest
	case errors.Is(err, store.ErrDependencyNotMet):
		return http.StatusConflict
	case errors.Is(err, store.ErrDependencyCycle):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
