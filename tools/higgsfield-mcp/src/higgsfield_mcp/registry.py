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
    supports_motions: bool = False
    default_dimensions: str | None = None
    available_dimensions: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Image Generation Models (8)
# ---------------------------------------------------------------------------

IMAGE_MODELS: dict[str, ModelSpec] = {
    "soul": ModelSpec(
        name="soul",
        application="higgsfield/soul/v2/text-to-image",
        category="image",
        display_name="Soul v2",
        description="Higgsfield flagship model with style and character reference support",
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
    "nano-banana-pro": ModelSpec(
        name="nano-banana-pro",
        application="google/gemini-3-pro/text-to-image",
        category="image",
        display_name="Nano Banana Pro",
        description="Google Gemini 3 Pro — 4K output, strong text rendering",
    ),
    "seedream-4.5": ModelSpec(
        name="seedream-4.5",
        application="bytedance/seedream/v4.5/text-to-image",
        category="image",
        display_name="Seedream 4.5",
        description="ByteDance photorealistic image generation",
    ),
    "flux-2": ModelSpec(
        name="flux-2",
        application="black-forest-labs/flux/v2/text-to-image",
        category="image",
        display_name="FLUX.2",
        description="Black Forest Labs creative image generation",
    ),
    "gpt-image-1.5": ModelSpec(
        name="gpt-image-1.5",
        application="openai/gpt-image/v1.5/text-to-image",
        category="image",
        display_name="GPT Image 1.5",
        description="OpenAI versatile image generation",
    ),
    "reve": ModelSpec(
        name="reve",
        application="reve/reve/v1/text-to-image",
        category="image",
        display_name="Reve",
        description="Artistic image generation",
    ),
    "popcorn": ModelSpec(
        name="popcorn",
        application="bytedance/popcorn/v1/text-to-image",
        category="image",
        display_name="Popcorn",
        description="ByteDance stylized image generation",
    ),
    "z-image-turbo": ModelSpec(
        name="z-image-turbo",
        application="z-image/turbo/v1/text-to-image",
        category="image",
        display_name="Z Image Turbo",
        description="Fast image generation",
    ),
}

# ---------------------------------------------------------------------------
# Video Generation Models (7)
# ---------------------------------------------------------------------------

VIDEO_MODELS: dict[str, ModelSpec] = {
    "dop": ModelSpec(
        name="dop",
        application="higgsfield/dop/v1/image-to-video",
        category="video",
        display_name="DOP",
        description="Image-to-video with motion presets",
        input_type="image",
        supports_motions=True,
    ),
    "sora-2": ModelSpec(
        name="sora-2",
        application="openai/sora/v2/text-to-video",
        category="video",
        display_name="Sora 2",
        description="OpenAI text-to-video generation",
    ),
    "kling-2.6": ModelSpec(
        name="kling-2.6",
        application="kuaishou/kling/v2.6/text-to-video",
        category="video",
        display_name="Kling 2.6",
        description="Kuaishou high-quality video generation",
    ),
    "veo-3.1": ModelSpec(
        name="veo-3.1",
        application="google/veo/v3.1/text-to-video",
        category="video",
        display_name="Veo 3.1",
        description="Google long-form video generation",
    ),
    "wan-2.6": ModelSpec(
        name="wan-2.6",
        application="alibaba/wan/v2.6/text-to-video",
        category="video",
        display_name="Wan 2.6",
        description="Alibaba diverse-style video generation",
    ),
    "minimax-02": ModelSpec(
        name="minimax-02",
        application="minimax/minimax/v02/text-to-video",
        category="video",
        display_name="Minimax 02",
        description="Efficient video generation",
    ),
    "seedance-1.5-pro": ModelSpec(
        name="seedance-1.5-pro",
        application="bytedance/seedance/v1.5-pro/image-to-video",
        category="video",
        display_name="Seedance 1.5 Pro",
        description="ByteDance image-to-video with dance/motion",
        input_type="image",
    ),
}

# ---------------------------------------------------------------------------
# Editing Tools (10)
# ---------------------------------------------------------------------------

EDIT_TOOLS: dict[str, ModelSpec] = {
    "inpaint": ModelSpec(
        name="inpaint",
        application="higgsfield/inpaint/v1/edit",
        category="edit",
        display_name="Inpaint",
        description="Edit regions of an image with mask-based inpainting",
        input_type="image",
    ),
    "upscale": ModelSpec(
        name="upscale",
        application="higgsfield/upscale/v1/edit",
        category="edit",
        display_name="Upscale",
        description="Upscale image resolution",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
    "relight": ModelSpec(
        name="relight",
        application="higgsfield/relight/v1/edit",
        category="edit",
        display_name="Relight",
        description="Change lighting conditions of an image",
        input_type="image",
    ),
    "face-swap": ModelSpec(
        name="face-swap",
        application="higgsfield/face-swap/v1/edit",
        category="edit",
        display_name="Face Swap",
        description="Swap faces between images",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
    "character-swap": ModelSpec(
        name="character-swap",
        application="higgsfield/character-swap/v1/edit",
        category="edit",
        display_name="Character Swap",
        description="Swap characters between images",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
    "draw-to-edit": ModelSpec(
        name="draw-to-edit",
        application="higgsfield/draw-to-edit/v1/edit",
        category="edit",
        display_name="Draw to Edit",
        description="Edit an image using drawn mask regions",
        input_type="image",
    ),
    "video-upscale": ModelSpec(
        name="video-upscale",
        application="higgsfield/video-upscale/v1/edit",
        category="edit",
        display_name="Video Upscale",
        description="Upscale video resolution",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
    "lipsync": ModelSpec(
        name="lipsync",
        application="higgsfield/lipsync/v1/edit",
        category="edit",
        display_name="Lipsync",
        description="Synchronize lip movements to audio",
        input_type="image",
        supports_enhance_prompt=False,
        supports_seed=False,
    ),
    "cinema-studio": ModelSpec(
        name="cinema-studio",
        application="higgsfield/cinema-studio/v1/edit",
        category="edit",
        display_name="Cinema Studio",
        description="Cinematic video editing and enhancement",
        input_type="image",
    ),
    "motion-control": ModelSpec(
        name="motion-control",
        application="higgsfield/motion-control/v1/edit",
        category="edit",
        display_name="Motion Control",
        description="Control motion trajectories in video",
        input_type="image",
    ),
}

# ---------------------------------------------------------------------------
# Speech Models (1)
# ---------------------------------------------------------------------------

SPEECH_MODELS: dict[str, ModelSpec] = {
    "speak": ModelSpec(
        name="speak",
        application="higgsfield/speak/v1/speech",
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
