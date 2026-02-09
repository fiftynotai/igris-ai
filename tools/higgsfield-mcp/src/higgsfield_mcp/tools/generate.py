"""generate_image and generate_video tool handlers."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.registry import IMAGE_MODELS, VIDEO_MODELS, get_model


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="generate_image",
            description=(
                "Generate images from text. Models: "
                + ", ".join(IMAGE_MODELS.keys())
            ),
            inputSchema={
                "type": "object",
                "required": ["prompt", "model"],
                "properties": {
                    "model": {
                        "type": "string",
                        "enum": list(IMAGE_MODELS.keys()),
                        "description": "Image model to use",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Text description of the image",
                    },
                    "width_and_height": {
                        "type": "string",
                        "description": "Dimensions like '1696x960'",
                    },
                    "quality": {
                        "type": "string",
                        "enum": ["720p", "1080p"],
                    },
                    "enhance_prompt": {
                        "type": "boolean",
                        "default": True,
                    },
                    "batch_size": {
                        "type": "integer",
                        "enum": [1, 4],
                    },
                    "seed": {"type": "integer"},
                    "style_id": {
                        "type": "string",
                        "description": "Style preset UUID (Soul only)",
                    },
                    "style_strength": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "custom_reference_id": {
                        "type": "string",
                        "description": "Character reference UUID (Soul only)",
                    },
                    "custom_reference_strength": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                    },
                    "image_reference_url": {
                        "type": "string",
                        "description": "Reference image URL",
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
        Tool(
            name="generate_video",
            description=(
                "Generate video from text or image. Models: "
                + ", ".join(VIDEO_MODELS.keys())
            ),
            inputSchema={
                "type": "object",
                "required": ["prompt", "model"],
                "properties": {
                    "model": {
                        "type": "string",
                        "enum": list(VIDEO_MODELS.keys()),
                        "description": "Video model to use",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Text description for the video",
                    },
                    "input_image_url": {
                        "type": "string",
                        "description": (
                            "Source image URL (required for image-to-video "
                            "models like DOP, Seedance)"
                        ),
                    },
                    "input_image_end_url": {
                        "type": "string",
                        "description": "End frame image URL (DOP only)",
                    },
                    "motions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "strength": {
                                    "type": "number",
                                    "minimum": 0,
                                    "maximum": 1,
                                },
                            },
                        },
                        "description": "Motion presets (DOP only)",
                    },
                    "enhance_prompt": {
                        "type": "boolean",
                        "default": True,
                    },
                    "seed": {"type": "integer"},
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


def _build_arguments(arguments: dict[str, Any], spec_keys: set[str]) -> dict:
    """Build SDK arguments dict, filtering out meta keys."""
    meta_keys = {"model", "wait_for_result"}
    return {k: v for k, v in arguments.items() if k not in meta_keys}


async def handle(
    name: str,
    arguments: dict[str, Any],
    client: AsyncClient,
    rest_client: Any,
) -> list[TextContent]:
    model_name = arguments.get("model", "")
    wait = arguments.get("wait_for_result", False)

    try:
        spec = get_model(model_name)
    except ValueError as e:
        return [TextContent(type="text", text=f"Error: {e}")]

    sdk_args = _build_arguments(arguments, set())

    try:
        controller = await client.submit(
            application=spec.application,
            arguments=sdk_args,
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
                "model": spec.display_name,
                "status": "submitted",
                "message": (
                    f"Job submitted to {spec.display_name}. "
                    f"Use manage_job with request_id to check status."
                ),
            }, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
