"""generate_speech tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.registry import SPEECH_MODELS


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
    rest_client: Any,
) -> list[TextContent]:
    wait = arguments.pop("wait_for_result", False)
    spec = SPEECH_MODELS["speak"]

    try:
        controller = await client.submit(
            application=spec.application,
            arguments=arguments,
        )

        if wait:
            result = await controller.get()
            return [TextContent(
                type="text",
                text=json.dumps(result, indent=2),
            )]

        return [TextContent(
            type="text",
            text=json.dumps({
                "request_id": controller.request_id,
                "status": "submitted",
                "message": (
                    "Speech job submitted. "
                    "Use manage_job with request_id to check status."
                ),
            }, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
