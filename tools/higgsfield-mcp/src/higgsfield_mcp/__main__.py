"""Entry point for python -m higgsfield_mcp."""

import asyncio
from higgsfield_mcp.server import run

asyncio.run(run())
