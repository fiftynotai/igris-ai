"""manage_job tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient, Completed, Failed, NSFW, Cancelled
from higgsfield_mcp.rest_client import HiggsfieldRestClient


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="manage_job",
            description="Check status, retrieve results, or cancel a generation job.",
            inputSchema={
                "type": "object",
                "required": ["action", "request_id"],
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "result", "cancel"],
                        "description": (
                            "status: check current state, "
                            "result: poll until done and return output, "
                            "cancel: cancel a queued job"
                        ),
                    },
                    "request_id": {
                        "type": "string",
                        "description": "Request ID from any generation call",
                    },
                },
            },
        ),
    ]


def _status_name(status: object) -> str:
    """Get human-readable status name."""
    return type(status).__name__.lower()


async def handle(
    name: str,
    arguments: dict[str, Any],
    client: AsyncClient,
    rest_client: HiggsfieldRestClient,
) -> list[TextContent]:
    action = arguments.get("action", "")
    request_id = arguments.get("request_id", "")

    if not request_id:
        return [TextContent(type="text", text="Error: request_id is required")]

    try:
        if action == "status":
            status = await client.status(request_id)
            return [TextContent(
                type="text",
                text=json.dumps({
                    "request_id": request_id,
                    "status": _status_name(status),
                }, indent=2),
            )]

        elif action == "result":
            result = await client.result(request_id)
            return [TextContent(
                type="text",
                text=json.dumps(result, indent=2),
            )]

        elif action == "cancel":
            await client.cancel(request_id)
            return [TextContent(
                type="text",
                text=json.dumps({
                    "request_id": request_id,
                    "status": "cancelled",
                }, indent=2),
            )]

        else:
            return [TextContent(
                type="text",
                text=f"Error: Unknown action '{action}'. Use: status, result, cancel",
            )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
