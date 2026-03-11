#!/usr/bin/env python3
"""
Local dev server — mirrors the production envoy routing on a single port:
  /api/*  → proxied to go2rtc (kubectl port-forward on 8081)
  /*      → static files from src/

Usage:
  kubectl port-forward svc/go2rtc -n automation 8081:80 &
  python3 dev-server.py
"""

import aiohttp
from aiohttp import web, WSMsgType

STATIC_DIR = "src"
GO2RTC = "http://localhost:8081"
PORT = 8080


async def proxy_http(request: web.Request) -> web.Response:
    """Proxy HTTP requests to go2rtc."""
    url = f"{GO2RTC}{request.path_qs}"
    body = await request.read()
    async with aiohttp.ClientSession() as session:
        async with session.request(
            request.method, url, data=body if body else None,
            headers={"Content-Type": request.content_type},
        ) as resp:
            data = await resp.read()
            return web.Response(
                body=data,
                status=resp.status,
                content_type=resp.content_type,
            )


async def proxy_ws(request: web.Request) -> web.WebSocketResponse:
    """Proxy WebSocket connections to go2rtc."""
    ws_client = web.WebSocketResponse()
    await ws_client.prepare(request)

    url = f"ws://localhost:8081{request.path_qs}"

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(url) as ws_server:
            async def client_to_server():
                async for msg in ws_client:
                    if msg.type == WSMsgType.TEXT:
                        await ws_server.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await ws_server.send_bytes(msg.data)
                    elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                        break

            async def server_to_client():
                async for msg in ws_server:
                    if msg.type == WSMsgType.TEXT:
                        await ws_client.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await ws_client.send_bytes(msg.data)
                    elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                        break

            import asyncio
            await asyncio.gather(
                client_to_server(),
                server_to_client(),
                return_exceptions=True,
            )

    return ws_client


async def api_handler(request: web.Request):
    """Route API requests: WebSocket upgrade or HTTP proxy."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await proxy_ws(request)
    return await proxy_http(request)


app = web.Application()
async def index_handler(request: web.Request) -> web.Response:
    """Serve index.html for the root path."""
    return web.FileResponse(f"{STATIC_DIR}/index.html")

app.router.add_route("*", "/api/{path:.*}", api_handler)
app.router.add_get("/", index_handler)
app.router.add_static("/", STATIC_DIR)

if __name__ == "__main__":
    print(f"→ http://localhost:{PORT}")
    print(f"  Static: ./{STATIC_DIR}/")
    print(f"  API:    {GO2RTC}")
    print()
    web.run_app(app, port=PORT, print=None)
