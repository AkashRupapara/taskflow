#!/usr/bin/env python3
"""Concurrent load test for the paginated task endpoint.

Hammers GET /api/projects/<id>/tasks?limit=200 from many persistent connections
and reports throughput + latency percentiles. Run the API with RATE_LIMIT_RPS=0
to measure raw capacity rather than the rate limiter.

Usage: ./scripts/loadtest.py <project_id> [concurrency] [total_requests]
"""
import http.client
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HOST, PORT = "localhost", 8080

project_id = sys.argv[1]
concurrency = int(sys.argv[2]) if len(sys.argv) > 2 else 50
total = int(sys.argv[3]) if len(sys.argv) > 3 else 10000
path = f"/api/projects/{project_id}/tasks?limit=200"

latencies: list[float] = []
errors = 0
lock = threading.Lock()


def worker(count: int) -> None:
    global errors
    conn = http.client.HTTPConnection(HOST, PORT)
    local, errs = [], 0
    for _ in range(count):
        t0 = time.perf_counter()
        conn.request("GET", path)
        r = conn.getresponse()
        r.read()
        dt = (time.perf_counter() - t0) * 1000
        if r.status == 200:
            local.append(dt)
        else:
            errs += 1
    with lock:
        latencies.extend(local)
        errors += errs


per = total // concurrency
start = time.time()
with ThreadPoolExecutor(max_workers=concurrency) as ex:
    list(ex.map(worker, [per] * concurrency))
elapsed = time.time() - start

latencies.sort()
n = len(latencies)


def pct(p: float) -> float:
    return latencies[min(int(n * p), n - 1)] if n else 0.0


print(f"endpoint:     GET {path}")
print(f"requests:     {n}  (errors: {errors})")
print(f"concurrency:  {concurrency}")
print(f"duration:     {elapsed:.2f}s")
print(f"throughput:   {n / elapsed:.0f} req/s")
print(f"latency mean: {statistics.mean(latencies):.1f} ms")
print(f"latency p50:  {pct(0.50):.1f} ms")
print(f"latency p95:  {pct(0.95):.1f} ms")
print(f"latency p99:  {pct(0.99):.1f} ms")
print(f"latency max:  {latencies[-1]:.1f} ms")
