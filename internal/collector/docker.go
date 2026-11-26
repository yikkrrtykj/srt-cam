package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// DockerClient talks directly to Docker Engine over its local Unix domain socket using stdlib HTTP.
// Zero third-party Docker SDK bloat; keeps control plane decoupled from data-plane containers.
type DockerClient struct {
	socketPath string
	httpClient *http.Client
}

// ContainerInfo summarizes inspected Docker container state.
type ContainerInfo struct {
	Name         string
	Status       string // running, exited, restarting, not_found
	Running      bool
	RestartCount int
	StartedAt    time.Time
}

// NewDockerClient creates a Unix-socket Docker Engine client.
func NewDockerClient(socketPath string) *DockerClient {
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &DockerClient{
		socketPath: socketPath,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   8 * time.Second,
		},
	}
}

// Inspect returns container runtime state and restart count.
func (d *DockerClient) Inspect(ctx context.Context, name string) (ContainerInfo, error) {
	endpoint := fmt.Sprintf("http://docker/containers/%s/json", url.PathEscape(name))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ContainerInfo{Name: name, Status: "unknown"}, err
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return ContainerInfo{Name: name, Status: "docker_unreachable"}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ContainerInfo{Name: name, Status: "not_found"}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return ContainerInfo{Name: name, Status: "error"}, fmt.Errorf("docker inspect %s: HTTP %d", name, resp.StatusCode)
	}

	var payload struct {
		RestartCount int `json:"RestartCount"`
		State        struct {
			Status    string `json:"Status"`
			Running   bool   `json:"Running"`
			StartedAt string `json:"StartedAt"`
		} `json:"State"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ContainerInfo{Name: name, Status: "error"}, err
	}

	started, _ := time.Parse(time.RFC3339Nano, payload.State.StartedAt)
	return ContainerInfo{
		Name:         name,
		Status:       payload.State.Status,
		Running:      payload.State.Running,
		RestartCount: payload.RestartCount,
		StartedAt:    started,
	}, nil
}

// RecentLogs fetches timestamped stdout+stderr logs for the last sinceSec seconds (bounded tail).
func (d *DockerClient) RecentLogs(ctx context.Context, name string, sinceSec int, tail int) (string, error) {
	if sinceSec <= 0 {
		sinceSec = 120
	}
	if tail <= 0 {
		tail = 400
	}
	sinceUnix := time.Now().Add(-time.Duration(sinceSec) * time.Second).Unix()
	endpoint := fmt.Sprintf("http://docker/containers/%s/logs?stdout=1&stderr=1&timestamps=1&since=%d&tail=%d",
		url.PathEscape(name), sinceUnix, tail)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("docker logs %s: HTTP %d", name, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	return DemuxDockerStream(raw), nil
}

// Restart safely restarts ONLY the single specified container without touching any sibling channel.
func (d *DockerClient) Restart(ctx context.Context, name string, timeoutSec int) error {
	if timeoutSec <= 0 {
		timeoutSec = 5
	}
	endpoint := fmt.Sprintf("http://docker/containers/%s/restart?t=%d", url.PathEscape(name), timeoutSec)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker restart %s: HTTP %d (%s)", name, resp.StatusCode, string(body))
	}
	return nil
}
