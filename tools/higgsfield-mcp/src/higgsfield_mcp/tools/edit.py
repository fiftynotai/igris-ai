"""edit_media tool handler — Seedream Edit only."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.registry import EDIT_TOOLS


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="edit_media",
            description="Edit images using Seedream Edit (bytedance/seedream/v4/edit).",
            inputSchema={
                "type": "object",
                "required": ["image_urls", "prompt"],
                "properties": {
                    "image_urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "URLs of images to edit",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Edit instruction describing what to change",
                    },
                    "wait_for_result": {
                        "type": "boolean",
                        "default": False,
                        "description": "If true, poll until complete and return result.",
                    },
                },
            },
        ),
    ]


async def handle(
    name: str,
    arguments: dict[str, Any],
    client: AsyncClient,
    rest_client: Any,
) -> list[TextContent]:
    wait = arguments.get("wait_for_result", False)
    spec = EDIT_TOOLS["seedream-edit"]

    sdk_args = {
        "image_urls": arguments["image_urls"],
        "prompt": arguments["prompt"],
    }

    try:
        controller = await client.submit(
            application=spec.application,
            arguments=sdk_args,
        )

        if wait:
            result = await controller.get()
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        return [TextContent(
            type="text",
            text=json.dumps({
                "request_id": controller.request_id,
                "model": spec.display_name,
                "status": "submitted",
                "message": f"Job submitted to {spec.display_name}. Use manage_job with request_id to check status.",
            }, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
