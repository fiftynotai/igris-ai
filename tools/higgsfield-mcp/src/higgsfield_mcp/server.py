"""Higgsfield MCP Server — full platform access via official SDK."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient, CredentialsMissedError
from higgsfield_mcp.rest_client import HiggsfieldRestClient
from higgsfield_mcp.tools import (
    characters,
    edit,
    generate,
    jobs,
    metadata,
    speech,
    upload,
)

logger = logging.getLogger(__name__)

app = Server("higgsfield-mcp")

# Lazy singletons — created on first tool call
_sdk_client: AsyncClient | None = None
_rest_client: HiggsfieldRestClient | None = None

# Tool name → handler module mapping
TOOL_HANDLERS = {
    "generate_image": generate,
    "generate_video": generate,
    "edit_media": edit,
    "generate_speech": speech,
    "list_styles": metadata,
    "list_motions": metadata,
    "manage_character": characters,
    "manage_job": jobs,
    "upload_file": upload,
}


def _get_sdk_client() -> AsyncClient:
    global _sdk_client
    if _sdk_client is None:
        _sdk_client = AsyncClient()
    return _sdk_client


def _get_rest_client() -> HiggsfieldRestClient:
    global _rest_client
    if _rest_client is None:
        _rest_client = HiggsfieldRestClient()
    return _rest_client


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        *generate.list_tools(),
        *edit.list_tools(),
        *speech.list_tools(),
        *metadata.list_tools(),
        *characters.list_tools(),
        *jobs.list_tools(),
        *upload.list_tools(),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    handler_module = TOOL_HANDLERS.get(name)
    if handler_module is None:
        return [TextContent(
            type="text",
            text=f"Error: Unknown tool '{name}'",
        )]

    try:
        client = _get_sdk_client()
        rest = _get_rest_client()
    except CredentialsMissedError as e:
        return [TextContent(
            type="text",
            text=(
                f"Auth error: {e}\n\n"
                "Set HF_KEY (or HF_API_KEY + HF_API_SECRET) in your "
                "MCP server environment configuration."
            ),
        )]

    return await handler_module.handle(name, arguments, client, rest)


async def run() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options(),
        )


def main() -> None:
    asyncio.run(run())
