"""manage_character tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.rest_client import HiggsfieldRestClient


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="manage_character",
            description=(
                "Create, get, or delete character references "
                "for consistent image generation."
            ),
            inputSchema={
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "get", "delete"],
                        "description": "Operation to perform",
                    },
                    "name": {
                        "type": "string",
                        "description": "Character name (required for create)",
                    },
                    "image_urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Reference image URLs (required for create, 1-100)",
                    },
                    "reference_id": {
                        "type": "string",
                        "description": "Character UUID (required for get/delete)",
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
    action = arguments.get("action", "")

    try:
        if action == "create":
            char_name = arguments.get("name")
            image_urls = arguments.get("image_urls")
            if not char_name or not image_urls:
                return [TextContent(
                    type="text",
                    text="Error: 'name' and 'image_urls' are required for create",
                )]
            data = await rest_client.create_character(char_name, image_urls)

        elif action == "get":
            ref_id = arguments.get("reference_id")
            if not ref_id:
                return [TextContent(
                    type="text",
                    text="Error: 'reference_id' is required for get",
                )]
            data = await rest_client.get_character(ref_id)

        elif action == "delete":
            ref_id = arguments.get("reference_id")
            if not ref_id:
                return [TextContent(
                    type="text",
                    text="Error: 'reference_id' is required for delete",
                )]
            data = await rest_client.delete_character(ref_id)

        else:
            return [TextContent(
                type="text",
                text=f"Error: Unknown action '{action}'. Use: create, get, delete",
            )]

        return [TextContent(
            type="text",
            text=json.dumps(data, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
