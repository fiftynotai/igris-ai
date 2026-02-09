"""Direct REST client for 3 metadata endpoints not covered by the SDK."""

import httpx
from higgsfield_client.auth import get_credential_key

BASE_URL = "https://platform.higgsfield.ai"


class HiggsfieldRestClient:
    """Thin wrapper for styles, motions, and character CRUD endpoints."""

    def __init__(self) -> None:
        api_key = get_credential_key()
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            headers={
                "Authorization": f"Key {api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def list_styles(self) -> list[dict]:
        resp = await self._client.get("/v1/text2image/soul-styles")
        resp.raise_for_status()
        return resp.json()

    async def list_motions(self) -> list[dict]:
        resp = await self._client.get("/v1/motions")
        resp.raise_for_status()
        return resp.json()

    async def create_character(
        self, name: str, image_urls: list[str]
    ) -> dict:
        resp = await self._client.post(
            "/v1/custom-references",
            json={"name": name, "image_urls": image_urls},
        )
        resp.raise_for_status()
        return resp.json()

    async def get_character(self, reference_id: str) -> dict:
        resp = await self._client.get(f"/v1/custom-references/{reference_id}")
        resp.raise_for_status()
        return resp.json()

    async def delete_character(self, reference_id: str) -> dict:
        resp = await self._client.delete(
            f"/v1/custom-references/{reference_id}"
        )
        resp.raise_for_status()
        return resp.json()

    async def speak(self, params: dict) -> dict:
        resp = await self._client.post(
            "/v1/speak/higgsfield", json={"params": params}
        )
        resp.raise_for_status()
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()
