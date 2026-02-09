"""edit_media tool handler."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import TextContent, Tool

from higgsfield_client import AsyncClient
from higgsfield_mcp.registry import EDIT_TOOLS, get_model


def list_tools() -> list[Tool]:
    return [
        Tool(
            name="edit_media",
            description=(
                "Edit images or videos. Tools: "
                + ", ".join(EDIT_TOOLS.keys())
            ),
            inputSchema={
                "type": "object",
                "required": ["tool", "input_url"],
                "properties": {
                    "tool": {
                        "type": "string",
                        "enum": list(EDIT_TOOLS.keys()),
                        "description": "Editing tool to use",
                    },
                    "input_url": {
                        "type": "string",
                        "description": "URL of the image/video to edit",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Edit instruction (tool-dependent)",
                    },
                    "mask_url": {
                        "type": "string",
                        "description": "Mask image URL (inpaint, draw-to-edit)",
                    },
                    "reference_url": {
                        "type": "string",
                        "description": "Reference image URL (face-swap, character-swap)",
                    },
                    "parameters": {
                        "type": "object",
                        "description": "Tool-specific additional parameters",
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
    tool_name = arguments.get("tool", "")
    wait = arguments.get("wait_for_result", False)

    try:
        spec = get_model(tool_name)
    except ValueError as e:
        return [TextContent(type="text", text=f"Error: {e}")]

    # Build SDK arguments
    sdk_args: dict[str, Any] = {}
    if "input_url" in arguments:
        sdk_args["input_image_url"] = arguments["input_url"]
    if "prompt" in arguments:
        sdk_args["prompt"] = arguments["prompt"]
    if "mask_url" in arguments:
        sdk_args["mask_url"] = arguments["mask_url"]
    if "reference_url" in arguments:
        sdk_args["reference_url"] = arguments["reference_url"]
    # Merge any extra tool-specific parameters
    if "parameters" in arguments and isinstance(arguments["parameters"], dict):
        sdk_args.update(arguments["parameters"])

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
                "tool": spec.display_name,
                "status": "submitted",
                "message": (
                    f"Edit job submitted to {spec.display_name}. "
                    f"Use manage_job with request_id to check status."
                ),
            }, indent=2),
        )]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
