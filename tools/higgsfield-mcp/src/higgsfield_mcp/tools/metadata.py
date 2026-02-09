"""list_styles and list_motions tool handlers."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.rest_client import HiggsfieldRestClient


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="list_styles",
            description="List available style presets for Soul image generation.",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="list_motions",
            description="List available motion presets for DOP video generation.",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


async def handle(
    name: str,
    arguments: dict[str, Any],
    client: AsyncClient,
    rest_client: HiggsfieldRestClient,
) -> list[TextContent]:
    try:
        if name == "list_styles":
            data = await rest_client.list_styles()
        elif name == "list_motions":
            data = await rest_client.list_motions()
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

        return [TextContent(
            type="text",
            text=json.dumps(data, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
