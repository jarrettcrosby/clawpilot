from __future__ import annotations

import os
import secrets

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .models import (
    AssortmentOptimizationRequest,
    FulfillmentOptimizationRequest,
)
from .solver import (
    ASSORTMENT_ALGORITHM_VERSION,
    FULFILLMENT_ALGORITHM_VERSION,
    MAX_CANONICAL_BODY_BYTES,
    OptimizerBoundError,
    canonical_sha256,
    input_payload,
    solve_assortment,
    solve_fulfillment,
)


MAX_RESPONSE_BYTES = 1_048_576
SERVICE_VERSION = "1.0.0"
OPTIMIZER_SECRET_ENV = "CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET"

app = FastAPI(
    title="ClawPilot Fulfillment Optimizer",
    version=SERVICE_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def configured_secret() -> str | None:
    value = os.environ.get(OPTIMIZER_SECRET_ENV, "")
    return value if len(value.encode("utf-8")) >= 32 else None


def verify_bearer(request: Request) -> None:
    expected = configured_secret()
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "OPTIMIZER_NOT_CONFIGURED"},
        )
    authorization = request.headers.get("authorization", "")
    scheme, separator, provided = authorization.partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not secrets.compare_digest(
            provided.encode("utf-8"),
            expected.encode("utf-8"),
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "OPTIMIZER_UNAUTHORIZED"},
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.middleware("http")
async def bounded_body(request: Request, call_next):
    if request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_CANONICAL_BODY_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"error": {"code": "OPTIMIZER_REQUEST_TOO_LARGE"}},
                    )
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"error": {"code": "OPTIMIZER_CONTENT_LENGTH_INVALID"}},
                )
        body = await request.body()
        if len(body) > MAX_CANONICAL_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content={"error": {"code": "OPTIMIZER_REQUEST_TOO_LARGE"}},
            )
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(RequestValidationError)
async def request_validation_error(_request: Request, error: RequestValidationError):
    errors = [
        {
            "path": ".".join(str(item) for item in issue["loc"]),
            "type": issue["type"],
            "message": issue["msg"],
        }
        for issue in error.errors()[:20]
    ]
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "OPTIMIZER_REQUEST_INVALID",
                "issues": errors,
            }
        },
    )


@app.get("/health")
def health():
    ready = configured_secret() is not None
    content = {
        "ok": ready,
        "service": "clawpilot-fulfillment-optimizer",
        "serviceVersion": SERVICE_VERSION,
        "fulfillmentAlgorithmVersion": FULFILLMENT_ALGORITHM_VERSION,
        "assortmentAlgorithmVersion": ASSORTMENT_ALGORITHM_VERSION,
    }
    return JSONResponse(
        status_code=200 if ready else 503,
        content=content,
        headers={"Cache-Control": "no-store"},
    )


def check_hash(expected_hash: str, payload: dict) -> None:
    actual_hash = canonical_sha256(payload)
    if not secrets.compare_digest(actual_hash, expected_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "OPTIMIZER_INPUT_HASH_MISMATCH"},
        )


def bounded_result(result: dict) -> dict:
    from .solver import canonical_json

    if len(canonical_json(result).encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise HTTPException(
            status_code=500,
            detail={"code": "OPTIMIZER_RESPONSE_TOO_LARGE"},
        )
    return result


@app.post("/v1/optimize", dependencies=[Depends(verify_bearer)])
def optimize(request: FulfillmentOptimizationRequest):
    payload = input_payload(request.input)
    check_hash(request.input_hash, payload)
    try:
        return bounded_result(solve_fulfillment(
            request.input,
            request.options,
            request.input_hash,
        ))
    except OptimizerBoundError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OPTIMIZER_MODEL_BOUND_EXCEEDED",
                "message": str(error),
            },
        ) from error


@app.post("/v1/assortments/optimize", dependencies=[Depends(verify_bearer)])
def optimize_assortment(request: AssortmentOptimizationRequest):
    payload = input_payload(request.input)
    check_hash(request.input_hash, payload)
    try:
        return bounded_result(solve_assortment(
            request.input,
            request.options,
            request.input_hash,
        ))
    except OptimizerBoundError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OPTIMIZER_MODEL_BOUND_EXCEEDED",
                "message": str(error),
            },
        ) from error
