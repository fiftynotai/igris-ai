"""generate_speech tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.rest_client import HiggsfieldRestClient


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="generate_speech",
            description="Generate speech/talking-head video from text.",
            inputSchema={
                "type": "object",
                "required": ["prompt"],
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Text for speech generation",
                    },
                    "input_image_url": {
                        "type": "string",
                        "description": "Face/character image URL",
                    },
                    "input_audio_url": {
                        "type": "string",
                        "description": "Input audio URL",
                    },
                    "quality": {
                        "type": "string",
                        "default": "high",
                    },
                    "enhance_prompt": {
                        "type": "boolean",
                        "default": False,
                    },
                    "seed": {"type": "integer"},
                    "duration": {
                        "type": "integer",
                        "description": "Duration in seconds",
                    },
                    "wait_for_result": {
                        "type": "boolean",
                        "default": False,
                        "description": (
                            "If true, poll until complete and return result. "
                            "If false, return request_id immediately."
                        ),
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
    wait = arguments.pop("wait_for_result", False)

    # Build params from remaining arguments (excludes wait_for_result)
    params = {k: v for k, v in arguments.items()}

    try:
        response = await rest_client.speak(params)
        request_id = response.get("request_id", "")

        if wait and request_id:
            result = await client.result(request_id)
            return [TextContent(
                type="text",
                text=json.dumps(result, indent=2),
            )]

        return [TextContent(
            type="text",
            text=json.dumps({
                "request_id": request_id,
                "status": "submitted",
                "message": (
                    "Speech job submitted. "
                    "Use manage_job with request_id to check status."
                ),
            }, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
