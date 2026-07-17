package ws

import (
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second    // max time allowed to write a message
	pongWait   = 60 * time.Second    // max time to wait for a pong before closing
	pingPeriod = (pongWait * 9) / 10 // ping just under the pong deadline
	sendBuffer = 256                 // per-client outbound queue depth
)

// Client is one WebSocket connection subscribed to a single project room.
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	projectID string
	send      chan []byte // buffered; a full buffer means the client is too slow
}

func newClient(h *Hub, conn *websocket.Conn, projectID string) *Client {
	return &Client{hub: h, conn: conn, projectID: projectID, send: make(chan []byte, sendBuffer)}
}

// trySend queues a message, dropping it if the client's buffer is full. Dropping
// (rather than blocking the whole hub on one slow client) is safe because the
// client can re-sync from its last version on reconnect.
func (c *Client) trySend(data []byte) {
	select {
	case c.send <- data:
	default:
		c.hub.logger("ws: dropping message for slow client on project %s", c.projectID)
	}
}

// readPump drains inbound messages (we don't expect any yet) and, importantly,
// handles pong replies to keep the connection alive. It also detects disconnects.
func (c *Client) readPump() {
	defer func() {
		c.hub.remove(c)
		_ = c.conn.Close()
	}()
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return // client closed or timed out
		}
	}
}

// writePump sends queued events and periodic pings on a single goroutine (the
// gorilla conn allows only one concurrent writer).
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case data, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok { // hub closed the channel
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
