from pathlib import Path
import json
import os
from typing import Any

from fastapi import Cookie, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from backend.api_response_logger import ApiResponseLogger, LOG_VERBOSITIES
from backend.extrahop_client import ExtraHopApiError, ExtraHopClient
from backend.session_store import SessionStore


APP_ROOT = Path(__file__).parent
SESSION_COOKIE = "eh_admin_session"

app = FastAPI(title="ExtraHop Admin Tools")
sessions = SessionStore()
api_response_logger = ApiResponseLogger(
    Path(os.environ.get("EH_API_RESPONSE_LOG", APP_ROOT / "logs" / "api-responses.jsonl")),
    os.environ.get("EH_API_LOG_VERBOSITY", "off"),
)

app.mount("/css", StaticFiles(directory=APP_ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=APP_ROOT / "js"), name="js")


class ConnectionConfig(BaseModel):
    type: str = Field(pattern="^(360|enterprise)$")
    tenant: str | None = None
    apiId: str | None = None
    apiSecret: str | None = None
    host: str | None = None
    apiKey: str | None = None
    proxyToken: str | None = None

    @model_validator(mode="after")
    def validate_config(self) -> "ConnectionConfig":
        if self.type == "360":
            if not self.tenant or not self.apiId or not self.apiSecret:
                raise ValueError("Tenant, API ID, and API Secret are required for RevealX 360")
        else:
            if not self.host or not self.apiKey:
                raise ValueError("Host and API Key are required for RevealX Enterprise")
        return self


class ApiLoggingConfig(BaseModel):
    verbosity: str = Field(pattern="^(off|errors|metadata|full)$")
    path: str | None = None


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(APP_ROOT / "index.html")


@app.get("/favicon.png")
async def favicon() -> FileResponse:
    return FileResponse(APP_ROOT / "favicon.png")


@app.get("/eh_logo.png")
async def logo() -> FileResponse:
    return FileResponse(APP_ROOT / "eh_logo.png")


@app.post("/backend/session")
async def create_session(config: ConnectionConfig, response: Response) -> dict[str, Any]:
    client = ExtraHopClient(config.model_dump(exclude_none=True), api_response_logger)

    try:
        await client.authenticate()
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail={
                "message": f"Connection failed: {error.__class__.__name__} - {str(error) or repr(error)}",
                "details": {
                    "status": "Backend Error",
                    "response": {
                        "type": error.__class__.__name__,
                        "message": str(error) or repr(error),
                    },
                },
            },
        ) from error

    session_id = sessions.create(client)
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return {"connected": True, "config": client.metadata.public_dict()}


@app.get("/backend/api-logging")
async def read_api_logging() -> dict[str, Any]:
    return api_response_logger.status()


@app.patch("/backend/api-logging")
async def update_api_logging(config: ApiLoggingConfig) -> dict[str, Any]:
    try:
        return api_response_logger.configure(config.verbosity, config.path)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"message": str(error), "valid": sorted(LOG_VERBOSITIES)},
        ) from error


@app.get("/backend/session")
async def read_session(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    client = sessions.get(eh_admin_session)
    if not client:
        raise HTTPException(status_code=401, detail={"message": "Not connected to an ExtraHop instance"})
    return {"connected": True, "config": client.metadata.public_dict()}


@app.get("/backend/system-health/catalog")
async def system_health_catalog(catalog_path: str | None = Query(default=None, alias="path")) -> dict[str, Any]:
    catalog_path = resolve_catalog_path(catalog_path)
    if not catalog_path.exists():
        return {"loaded": False, "path": str(catalog_path), "models": [], "lookup": {}}

    try:
        models = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=500,
            detail={"message": f"Could not load product catalog: {error}"},
        ) from error

    lookup = build_catalog_lookup(models)
    return {"loaded": True, "path": str(catalog_path), "models": models, "lookup": lookup}


@app.get("/backend/system-health/catalog/lookup")
async def system_health_catalog_lookup(catalog_path: str | None = Query(default=None, alias="path")) -> dict[str, Any]:
    catalog = await system_health_catalog(catalog_path)
    return {key: catalog[key] for key in ("loaded", "path", "lookup")}


@app.delete("/backend/session")
async def delete_session(
    response: Response,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, bool]:
    sessions.delete(eh_admin_session)
    response.delete_cookie(SESSION_COOKIE)
    return {"connected": False}


@app.post("/backend/session/refresh")
async def refresh_session(
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, bool]:
    client = get_session_client(eh_admin_session)
    try:
        await client.refresh_if_needed()
    except ExtraHopApiError as error:
        raise http_exception(error) from error
    return {"refreshed": True}


@app.api_route(
    "/backend/extrahop/{endpoint:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def proxy_extrahop_request(
    endpoint: str,
    request: Request,
    eh_admin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> Any:
    client = get_session_client(eh_admin_session)
    body = await request.body()

    try:
        return await client.request(
            request.method,
            endpoint,
            query_string=request.url.query,
            body=body or None,
            content_type=request.headers.get("content-type"),
        )
    except ExtraHopApiError as error:
        raise http_exception(error) from error


def get_session_client(session_id: str | None) -> ExtraHopClient:
    client = sessions.get(session_id)
    if not client:
        raise HTTPException(status_code=401, detail={"message": "Not connected to an ExtraHop instance"})
    return client


def resolve_catalog_path(override_path: str | None = None) -> Path:
    if override_path:
        return Path(override_path).expanduser()

    local_catalog = APP_ROOT / "catalog.eh.json"
    if local_catalog.exists():
        return local_catalog

    env_path = os.environ.get("EH_CATALOG_PATH")
    if env_path:
        candidate = Path(env_path).expanduser()
        if candidate.exists():
            return candidate

    return local_catalog


def build_catalog_lookup(models: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(models, list):
        return {}

    lookup: dict[str, dict[str, Any]] = {}
    for model in models:
        if not isinstance(model, dict) or not model.get("name"):
            continue
        performance = model.get("performance", {})
        if not isinstance(performance, dict):
            performance = {}
        lookup[str(model["name"]).upper()] = {
            "model": model["name"],
            "platform": model.get("platform", ""),
            "generation": model.get("generation"),
            "sale_status": model.get("sale_status", ""),
            "base_gbps": performance.get("base_gbps") or 0,
            "base_packetrate": performance.get("base_packetrate") or 0,
            "advanced_analysis": performance.get("advanced_analysis") or 0,
            "standard_analysis": performance.get("standard_analysis") or 0,
        }
    return lookup


def http_exception(error: ExtraHopApiError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"message": str(error), "details": error.details},
    )
