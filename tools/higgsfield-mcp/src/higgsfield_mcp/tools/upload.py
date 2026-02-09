"""upload_file tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.rest_client import HiggsfieldRestClient


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="upload_file",
            description=(
                "Upload a local file to Higgsfield CDN and get a public URL. "
                "Use this to provide input images/audio to generation tools."
            ),
            inputSchema={
                "type": "object",
                "required": ["file_path"],
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file to upload",
                    },
                },
            },
        ),
    ]


async def handle(
    name: str,
    arguments: dict[str, Any],
    client: AsyncClient,
    rest_client: HiggsfieldRestClient,
) -> list[TextContent]:
    file_path = arguments.get("file_path", "")

    if not file_path:
        return [TextContent(type="text", text="Error: file_path is required")]

    try:
        url = await client.upload_file(file_path)
        return [TextContent(
            type="text",
            text=json.dumps({
                "file_path": file_path,
                "public_url": url,
                "message": "File uploaded. Use this URL as input to generation tools.",
            }, indent=2),
        )]
    except FileNotFoundError:
        return [TextContent(
            type="text",
            text=f"Error: File not found: {file_path}",
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
