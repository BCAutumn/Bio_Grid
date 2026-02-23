import argparse
import json
import os
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import taichi as ti

from .config import Config
from .render import TaichiViewRenderer
from .tick_fast_ti import FastTicker, get_stats_fast, tick_fast
from .world_ti import WorldTI


_TI_READY = False
_TI_INIT_LOCK = threading.Lock()
_TI_RUNTIME_LOCK = threading.Lock()


def _ensure_taichi():
    global _TI_READY
    if _TI_READY:
        return
    with _TI_INIT_LOCK:
        if _TI_READY:
            return
        arch = (os.environ.get("BIOGRID_TAICHI_ARCH") or "gpu").lower()
        if arch in ("cpu",):
            ti.init(arch=ti.cpu, default_fp=ti.f32)
        else:
            # GPU 优先（macOS 会走 Metal）
            ti.init(arch=ti.gpu, default_fp=ti.f32)
        _TI_READY = True


@ti.kernel
def _brush_circle(
    a_type: ti.types.ndarray(dtype=ti.u8),
    a_biomass: ti.types.ndarray(dtype=ti.f32),
    a_energy: ti.types.ndarray(dtype=ti.f32),
    a_gene: ti.types.ndarray(dtype=ti.f32),
    a_age: ti.types.ndarray(dtype=ti.f32),
    b_type: ti.types.ndarray(dtype=ti.u8),
    b_biomass: ti.types.ndarray(dtype=ti.f32),
    b_energy: ti.types.ndarray(dtype=ti.f32),
    b_gene: ti.types.ndarray(dtype=ti.f32),
    b_age: ti.types.ndarray(dtype=ti.f32),
    width: ti.i32,
    height: ti.i32,
    cx: ti.i32,
    cy: ti.i32,
    radius: ti.i32,
    mode: ti.i32,
    gene_v: ti.f32,
):
    # mode: 0 life(seed), 1 disturb, 2 annihilate, 3 wall, 4 erase
    PLANT = ti.u8(1)
    EMPTY = ti.u8(0)
    WALL = ti.u8(3)
    r2 = ti.cast(radius * radius, ti.i32)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > r2:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            i = y * width + x
            if mode == 0:
                a_type[i] = PLANT
                a_biomass[i] = 0.8
                a_energy[i] = 30.0
                a_gene[i] = gene_v
                a_age[i] = 0.0
            elif mode == 1:
                # 扰动：削弱现存植被
                if a_type[i] == PLANT:
                    a_biomass[i] *= 0.35
                    a_energy[i] *= 0.55
                    a_age[i] = 0.0
            elif mode == 2:
                a_type[i] = EMPTY
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
            elif mode == 3:
                a_type[i] = WALL
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
            else:
                a_type[i] = EMPTY
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
    # 同步写回 back（简单做法：对同一圈复制一次）
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > r2:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            i = y * width + x
            b_type[i] = a_type[i]
            b_biomass[i] = a_biomass[i]
            b_energy[i] = a_energy[i]
            b_gene[i] = a_gene[i]
            b_age[i] = a_age[i]


class SimSession:
    def __init__(self):
        self.world: Optional[WorldTI] = None
        self.ticker: Optional[FastTicker] = None
        self.renderer: Optional[TaichiViewRenderer] = None

        self.running = True
        self.ticks_per_second = 300.0
        self.acc = 0.0
        self.last_ts = time.perf_counter()
        self.max_steps_per_frame = 160

        self.view = {"sx": 0.0, "sy": 0.0, "sw": 1.0, "sh": 1.0}
        self.view_mode = "eco"
        self.show_aging_glow = False

        self._last_stats_ts = 0.0
        self._stats_cache = {"plant_count": 0, "total_biomass": 0.0, "avg_gene": 0.0}

    def ensure_world(self, w: int, h: int):
        if self.world and self.world.width == w and self.world.height == h:
            return
        cfg = Config()
        self.world = WorldTI(w, h, cfg)
        self.world.set_terrain_linear()
        self.ticker = FastTicker(w, h)
        self.view = {"sx": 0.0, "sy": 0.0, "sw": float(w), "sh": float(h)}

    def ensure_renderer(self, out_w: int, out_h: int):
        if self.renderer and self.renderer.out_w == out_w and self.renderer.out_h == out_h:
            return
        self.renderer = TaichiViewRenderer(out_w, out_h)

    def step_if_needed(self):
        if not self.world or not self.ticker:
            return 0
        now = time.perf_counter()
        dt = now - self.last_ts
        self.last_ts = now
        if dt < 0:
            dt = 0
        if dt > 0.25:
            dt = 0.25
        steps = 0
        if self.running:
            self.acc = min(256.0, self.acc + dt * float(self.ticks_per_second))
            while self.acc >= 1.0 and steps < self.max_steps_per_frame:
                tick_fast(self.world, self.ticker)
                self.acc -= 1.0
                steps += 1
        return steps

    def maybe_update_stats(self):
        if not self.world:
            return
        now = time.perf_counter()
        if now - self._last_stats_ts < 0.8:
            return
        self._last_stats_ts = now
        try:
            self._stats_cache = get_stats_fast(self.world)
        except Exception:
            # stats 是非关键路径，失败就保持旧值
            pass


SESSION = SimSession()


class Handler(BaseHTTPRequestHandler):
    server_version = "BioGridDevBackend/0.1"

    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, status: int, content_type: str, data: bytes):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except Exception:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):  # noqa: N802
        if self.path in ("/health", "/api/health"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "biogrid-dev-backend",
                    "time": time.time(),
                },
            )
            return
        if self.path == "/api/frame":
            try:
                with _TI_RUNTIME_LOCK:
                    steps = SESSION.step_if_needed()
                    SESSION.maybe_update_stats()
                    if not SESSION.world or not SESSION.renderer:
                        self._send_json(400, {"ok": False, "error": "not_initialized"})
                        return

                    w = SESSION.world.width
                    h = SESSION.world.height
                    v = SESSION.view
                    # 避免把超大 now_ms(Unix ms) 传进 ti.f32 导致精度/溢出问题
                    now_ms = (time.perf_counter() * 1000.0) % 1_000_000.0
                    SESSION.renderer.render_view(
                        SESSION.world,
                        sx=float(v["sx"]),
                        sy=float(v["sy"]),
                        sw=float(v["sw"]),
                        sh=float(v["sh"]),
                        view_mode=str(SESSION.view_mode),
                        show_aging_glow=bool(SESSION.show_aging_glow),
                        now_ms=float(now_ms),
                    )
                    rgba = SESSION.renderer.get_rgba()  # (H,W,4) uint8
                    meta = {
                        "ok": True,
                        "engine": "taichi",
                        "world": {"width": int(w), "height": int(h)},
                        "canvas": {"width": int(SESSION.renderer.out_w), "height": int(SESSION.renderer.out_h)},
                        "sim": {
                            "running": bool(SESSION.running),
                            "ticksPerSecond": float(SESSION.ticks_per_second),
                            "backlog": float(SESSION.acc),
                            "steps": int(steps),
                            "time": float(SESSION.world.time),
                            "day": float(SESSION.world.day),
                            "sunlight": float(SESSION.world.sunlight),
                            "tick": int(SESSION.world.tick),
                        },
                        "stats": SESSION._stats_cache,
                        "view": {**v, "viewMode": str(SESSION.view_mode), "showAgingGlow": bool(SESSION.show_aging_glow)},
                    }
                    meta_bytes = json.dumps(meta, ensure_ascii=False).encode("utf-8")
                    header = struct.pack("<I", len(meta_bytes))
                    payload = header + meta_bytes + rgba.tobytes(order="C")
                    self._send_bytes(200, "application/octet-stream", payload)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": "frame_failed", "message": str(e)})
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path == "/api/message":
            try:
                msg = self._read_json()
                mtype = msg.get("type")
                if not isinstance(mtype, str):
                    self._send_json(400, {"ok": False, "error": "bad_message"})
                    return

                if mtype == "init":
                    with _TI_RUNTIME_LOCK:
                        w = int(msg.get("width") or 180)
                        h = int(msg.get("height") or 180)
                        out_w = int(msg.get("canvasWidth") or 720)
                        out_h = int(msg.get("canvasHeight") or 720)
                        seed_count = int(msg.get("seedCount") or 0)
                        tps = float(msg.get("ticksPerSecond") or 300.0)
                        sun_speed = float(msg.get("sunSpeed") or 0.014)
                        polar = bool(msg.get("polarDay") or False)
                        running = msg.get("running") is not False

                        SESSION.ensure_world(w, h)
                        SESSION.ensure_renderer(out_w, out_h)
                        assert SESSION.world is not None

                        SESSION.world.config.sunSpeed = max(0.004, min(0.12, sun_speed))
                        SESSION.world.config.polarDay = bool(polar)
                        SESSION.ticks_per_second = max(0.2, min(960.0, tps))
                        SESSION.running = bool(running)
                        SESSION.acc = 0.0
                        SESSION.last_ts = time.perf_counter()
                        SESSION.view = {"sx": 0.0, "sy": 0.0, "sw": float(w), "sh": float(h)}
                        SESSION.view_mode = "eco"
                        SESSION.show_aging_glow = False

                        if seed_count > 0:
                            SESSION.world.seed_plants(seed_count, seed=42)

                        self._send_json(200, {"ok": True, "type": "ready", "engine": "taichi"})
                    return

                if mtype == "setCanvasSize":
                    with _TI_RUNTIME_LOCK:
                        out_w = int(msg.get("width") or 720)
                        out_h = int(msg.get("height") or 720)
                        SESSION.ensure_renderer(out_w, out_h)
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setView":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.view = {
                            "sx": float(msg.get("sx") or 0.0),
                            "sy": float(msg.get("sy") or 0.0),
                            "sw": float(msg.get("sw") or SESSION.world.width),
                            "sh": float(msg.get("sh") or SESSION.world.height),
                        }
                        vm = msg.get("viewMode")
                        if isinstance(vm, str):
                            SESSION.view_mode = vm
                        sag = msg.get("showAgingGlow")
                        if isinstance(sag, bool):
                            SESSION.show_aging_glow = sag
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setRunning":
                    with _TI_RUNTIME_LOCK:
                        SESSION.running = bool(msg.get("running"))
                        SESSION.last_ts = time.perf_counter()
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setTicksPerSecond":
                    with _TI_RUNTIME_LOCK:
                        v = float(msg.get("value") or SESSION.ticks_per_second)
                        SESSION.ticks_per_second = max(0.2, min(960.0, v))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setSunSpeed":
                    with _TI_RUNTIME_LOCK:
                        if SESSION.world:
                            v = float(msg.get("value") or SESSION.world.config.sunSpeed)
                            SESSION.world.config.sunSpeed = max(0.004, min(0.12, v))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setPolarDayMode":
                    with _TI_RUNTIME_LOCK:
                        if SESSION.world:
                            SESSION.world.config.polarDay = bool(msg.get("value"))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setShowAgingGlow":
                    with _TI_RUNTIME_LOCK:
                        SESSION.show_aging_glow = bool(msg.get("value"))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "reset":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.world.reset()
                        SESSION.world.set_terrain_linear()
                        SESSION.acc = 0.0
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "randomSeed":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        count = int(msg.get("count") or 160)
                        SESSION.world.seed_plants(count, seed=42)
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "applyBrush":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        cx = int(msg.get("cx") or 0)
                        cy = int(msg.get("cy") or 0)
                        radius = int(msg.get("radius") or 3)
                        mode = msg.get("mode") or "life"
                        gene_v = float((msg.get("options") or {}).get("gene") or 0.5)
                        mode_i = 0
                        if mode == "disturb":
                            mode_i = 1
                        elif mode == "annihilate":
                            mode_i = 2
                        elif mode == "wall":
                            mode_i = 3
                        elif mode == "erase":
                            mode_i = 4
                        w = int(SESSION.world.width)
                        h = int(SESSION.world.height)
                        _brush_circle(
                            SESSION.world.front.type,
                            SESSION.world.front.biomass,
                            SESSION.world.front.energy,
                            SESSION.world.front.gene,
                            SESSION.world.front.age,
                            SESSION.world.back.type,
                            SESSION.world.back.biomass,
                            SESSION.world.back.energy,
                            SESSION.world.back.gene,
                            SESSION.world.back.age,
                            w,
                            h,
                            cx,
                            cy,
                            radius,
                            mode_i,
                            gene_v,
                        )
                        self._send_json(200, {"ok": True})
                    return

                self._send_json(400, {"ok": False, "error": "unsupported_type", "type": mtype})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": "message_failed", "message": str(e)})
            return

        self._send_json(404, {"ok": False, "error": "not_found"})

    def log_message(self, fmt, *args):  # quiet
        return


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bio-Grid minimal dev backend (placeholder).")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    args = p.parse_args(argv)

    _ensure_taichi()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[backend] running at http://{args.host}:{args.port}  (GET /health)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

