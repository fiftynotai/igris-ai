"""Model registry — single source of truth for all Higgsfield models."""

from dataclasses import dataclass, field


@dataclass
class ModelSpec:
    """Specification for a Higgsfield model."""
    name: str
    application: str
    category: str  # "image", "video", "edit", "speech"
    display_name: str
    description: str
    input_type: str = "text"  # "text", "image", "text+image"
    supports_enhance_prompt: bool = True
    supports_seed: bool = True
    supports_batch: bool = False
    supports_styles: bool = False
    supports_characters: bool = False
    default_dimensions: str | None = None
    available_dimensions: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Image Generation Models (5)
# ---------------------------------------------------------------------------

IMAGE_MODELS: dict[str, ModelSpec] = {
    "soul": ModelSpec(
        name="soul",
        application="higgsfield-ai/soul/standard",
        category="image",
        display_name="Soul",
        description="Higgsfield flagship text-to-image",
        supports_batch=True,
        supports_styles=True,
        supports_characters=True,
        default_dimensions="1696x960",
        available_dimensions=[
            "1152x2048", "2048x1152", "2048x1536", "1536x2048",
            "1344x2016", "2016x1344", "960x1696", "1536x1536",
            "1536x1152", "1696x960", "1152x1536", "1088x1632", "1632x1088",
        ],
    ),
    "soul-reference": ModelSpec(
        name="soul-reference",
        application="higgsfield-ai/soul/reference",
        category="image",
        display_name="Soul Reference",
        description="Soul with image reference guidance",
        input_type="text+image",
    ),
    "soul-character": ModelSpec(
        name="soul-character",
        application="higgsfield-ai/soul/character",
        category="image",
        display_name="Soul Character",
        description="Soul with character reference for consistency",
        supports_characters=True,
        supports_styles=True,
    ),
    "reve": ModelSpec(
        name="reve",
        application="reve/text-to-image",
        category="image",
        display_name="Reve",
        description="Artistic text-to-image generation",
    ),
    "seedream": ModelSpec(
        name="seedream",
        application="bytedance/seedream/v4/text-to-image",
        category="image",
        display_name="Seedream v4",
        description="ByteDance photorealistic image generation",
    ),
}

# ---------------------------------------------------------------------------
# Video Generation Models (11)
# ---------------------------------------------------------------------------

VIDEO_MODELS: dict[str, ModelSpec] = {
    "dop-lite": ModelSpec(
        name="dop-lite",
        application="higgsfield-ai/dop/lite",
        category="video",
        display_name="DOP Lite",
        description="Fast image-to-video animation",
        input_type="image",
    ),
    "dop": ModelSpec(
        name="dop",
        application="higgsfield-ai/dop/standard",
        category="video",
        display_name="DOP Standard",
        description="Standard quality image-to-video",
        input_type="image",
    ),
    "dop-turbo": ModelSpec(
        name="dop-turbo",
        application="higgsfield-ai/dop/turbo",
        category="video",
        display_name="DOP Turbo",
        description="Highest quality image-to-video",
        input_type="image",
    ),
    "dop-lite-flf": ModelSpec(
        name="dop-lite-flf",
        application="higgsfield-ai/dop/lite/first-last-frame",
        category="video",
        display_name="DOP Lite (First-Last Frame)",
        description="Fast first-last frame interpolation",
        input_type="image",
    ),
    "dop-flf": ModelSpec(
        name="dop-flf",
        application="higgsfield-ai/dop/standard/first-last-frame",
        category="video",
        display_name="DOP Standard (First-Last Frame)",
        description="Standard first-last frame interpolation",
        input_type="image",
    ),
    "dop-turbo-flf": ModelSpec(
        name="dop-turbo-flf",
        application="higgsfield-ai/dop/turbo/first-last-frame",
        category="video",
        display_name="DOP Turbo (First-Last Frame)",
        description="Best quality first-last frame interpolation",
        input_type="image",
    ),
    "kling-pro": ModelSpec(
        name="kling-pro",
        application="kling-video/v2.1/pro/image-to-video",
        category="video",
        display_name="Kling v2.1 Pro",
        description="High-fidelity cinematic image-to-video",
        input_type="image",
    ),
    "kling": ModelSpec(
        name="kling",
        application="kling-video/v2.1/standard/image-to-video",
        category="video",
        display_name="Kling v2.1 Standard",
        description="Standard cinematic image-to-video",
        input_type="image",
    ),
    "seedance-pro": ModelSpec(
        name="seedance-pro",
        application="bytedance/seedance/v1/pro/image-to-video",
        category="video",
        display_name="Seedance Pro",
        description="ByteDance professional image-to-video",
        input_type="image",
    ),
    "seedance-lite": ModelSpec(
        name="seedance-lite",
        application="bytedance/seedance/v1/lite/image-to-video",
        category="video",
        display_name="Seedance Lite",
        description="ByteDance fast image-to-video",
        input_type="image",
    ),
    "sora-2": ModelSpec(
        name="sora-2",
        application="sora-2/text-to-video",
        category="video",
        display_name="Sora 2",
        description="OpenAI text-to-video generation",
    ),
}

# ---------------------------------------------------------------------------
# Editing Tools (1)
# ---------------------------------------------------------------------------

EDIT_TOOLS: dict[str, ModelSpec] = {
    "seedream-edit": ModelSpec(
        name="seedream-edit",
        application="bytedance/seedream/v4/edit",
        category="edit",
        display_name="Seedream Edit",
        description="AI-powered image editing",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
}

# ---------------------------------------------------------------------------
# Speech Models (1)
# ---------------------------------------------------------------------------

SPEECH_MODELS: dict[str, ModelSpec] = {
    "speak": ModelSpec(
        name="speak",
        application="/v1/speak/higgsfield",
        category="speech",
        display_name="Speak",
        description="Text-to-speech talking-head video generation",
    ),
}

# ---------------------------------------------------------------------------
# Unified Registry
# ---------------------------------------------------------------------------

ALL_MODELS: dict[str, ModelSpec] = {
    **IMAGE_MODELS,
    **VIDEO_MODELS,
    **EDIT_TOOLS,
    **SPEECH_MODELS,
}


def get_model(name: str) -> ModelSpec:
    """Get model spec by short name. Raises ValueError if not found."""
    if name not in ALL_MODELS:
        available = sorted(ALL_MODELS.keys())
        raise ValueError(f"Unknown model '{name}'. Available: {available}")
    return ALL_MODELS[name]
