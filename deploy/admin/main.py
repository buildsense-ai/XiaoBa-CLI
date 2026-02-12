from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.templating import Jinja2Templates


APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parents[1]
TENANTS_DIR = REPO_ROOT / "tenants"
COMPOSE_FILE = REPO_ROOT / "deploy" / "docker-compose.multitenant.yml"
TENANT_ENV_TEMPLATE = REPO_ROOT / "deploy" / "docker" / "tenant.env.example"
RUNTIME_FILE_NAME = "runtime.json"
TENANT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")

DEFAULT_RUNTIME = {
    "cpus": "0.4",
    "mem_limit": "1g",
    "pids_limit": "512",
}

DATA_FOLDERS = (
    "files",
    "logs",
    "workspace",
    "extracted",
    "docs_analysis",
    "docs_runs",
    "docs_ppt",
    "audit",
)

security = HTTPBasic(auto_error=False)
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))


def require_auth(credentials: HTTPBasicCredentials | None = Depends(security)) -> None:
    user = os.getenv("XIAOBA_ADMIN_USER", "").strip()
    password = os.getenv("XIAOBA_ADMIN_PASSWORD", "").strip()
    if not user and not password:
        return

    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Basic"},
        )

    valid = secrets.compare_digest(credentials.username, user) and secrets.compare_digest(
        credentials.password, password
    )
    if not valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


app = FastAPI(
    title="XiaoBa Multi-Tenant Admin",
    version="0.1.0",
    dependencies=[Depends(require_auth)],
)


def validate_tenant_name(raw_name: str) -> str:
    tenant = raw_name.strip().lower()
    if not TENANT_NAME_PATTERN.fullmatch(tenant):
        raise HTTPException(
            status_code=400,
            detail="Invalid tenant name. Use 2-32 chars: a-z, 0-9, -, _",
        )
    return tenant


def tenant_dir(tenant: str) -> Path:
    return TENANTS_DIR / tenant


def tenant_env_path(tenant: str) -> Path:
    return tenant_dir(tenant) / ".env"


def tenant_runtime_path(tenant: str) -> Path:
    return tenant_dir(tenant) / RUNTIME_FILE_NAME


def load_runtime(tenant: str) -> dict[str, str]:
    runtime = dict(DEFAULT_RUNTIME)
    path = tenant_runtime_path(tenant)
    if not path.exists():
        return runtime

    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
        for key in runtime:
            value = str(stored.get(key, runtime[key])).strip()
            if value:
                runtime[key] = value
    except (json.JSONDecodeError, OSError):
        pass
    return runtime


def save_runtime(tenant: str, cpus: str, mem_limit: str, pids_limit: str) -> None:
    runtime = {
        "cpus": cpus.strip() or DEFAULT_RUNTIME["cpus"],
        "mem_limit": mem_limit.strip() or DEFAULT_RUNTIME["mem_limit"],
        "pids_limit": pids_limit.strip() or DEFAULT_RUNTIME["pids_limit"],
    }
    tenant_runtime_path(tenant).write_text(
        json.dumps(runtime, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )


def run_command(args: list[str], *, env: dict[str, str] | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def docker_env_for_tenant(tenant: str) -> dict[str, str]:
    runtime = load_runtime(tenant)
    env = os.environ.copy()
    env["TENANT"] = tenant
    env["TENANT_CPUS"] = runtime["cpus"]
    env["TENANT_MEM_LIMIT"] = runtime["mem_limit"]
    env["TENANT_PIDS_LIMIT"] = runtime["pids_limit"]
    return env


def compose_action(tenant: str, action: str, build: bool = False) -> subprocess.CompletedProcess[str]:
    command = [
        "docker",
        "compose",
        "-p",
        f"xiaoba-{tenant}",
        "-f",
        str(COMPOSE_FILE),
    ]
    if action == "up":
        command.extend(["up", "-d"])
        if build:
            command.append("--build")
    elif action in {"stop", "restart", "down"}:
        command.append(action)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported action: {action}")

    return run_command(command, env=docker_env_for_tenant(tenant), timeout=900)


def container_status(tenant: str) -> str:
    container = f"xiaoba-{tenant}"
    inspect = run_command(["docker", "inspect", "-f", "{{.State.Status}}", container], timeout=30)
    if inspect.returncode == 0:
        status = inspect.stdout.strip()
        return status or "unknown"

    ps = run_command(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name=^{container}$",
            "--format",
            "{{.Status}}",
        ],
        timeout=30,
    )
    if ps.returncode == 0 and ps.stdout.strip():
        return ps.stdout.strip()
    return "not_created"


def list_tenants() -> list[str]:
    if not TENANTS_DIR.exists():
        return []
    return sorted(
        entry.name
        for entry in TENANTS_DIR.iterdir()
        if entry.is_dir() and tenant_env_path(entry.name).exists()
    )


def ensure_tenant_scaffold(tenant: str) -> None:
    base = tenant_dir(tenant)
    data = base / "data"
    for folder in DATA_FOLDERS:
        (data / folder).mkdir(parents=True, exist_ok=True)

    env_file = tenant_env_path(tenant)
    if not env_file.exists():
        shutil.copyfile(TENANT_ENV_TEMPLATE, env_file)

    runtime_file = tenant_runtime_path(tenant)
    if not runtime_file.exists():
        runtime_file.write_text(
            json.dumps(DEFAULT_RUNTIME, ensure_ascii=True, indent=2) + "\n",
            encoding="utf-8",
        )


def tenant_view(tenant: str) -> dict[str, Any]:
    env_file = tenant_env_path(tenant)
    if not env_file.exists():
        raise HTTPException(status_code=404, detail=f"Tenant not found: {tenant}")

    env_content = env_file.read_text(encoding="utf-8")
    runtime = load_runtime(tenant)
    return {
        "name": tenant,
        "status": container_status(tenant),
        "env_content": env_content,
        "runtime": runtime,
        "path": str(tenant_dir(tenant)),
    }


@app.get("/", response_class=HTMLResponse)
def dashboard(
    request: Request,
    tenant: str | None = None,
    msg: str | None = None,
    level: str = "info",
) -> HTMLResponse:
    tenants = list_tenants()
    selected = tenant or (tenants[0] if tenants else None)
    selected_data: dict[str, Any] | None = None
    if selected:
        selected_data = tenant_view(selected)

    tenant_cards = []
    for name in tenants:
        tenant_cards.append(
            {
                "name": name,
                "status": container_status(name),
            }
        )

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "tenants": tenant_cards,
            "selected": selected_data,
            "message": msg,
            "level": level,
            "docker_ready": shutil.which("docker") is not None,
        },
    )


@app.get("/api/tenants", response_class=JSONResponse)
def api_tenants() -> JSONResponse:
    tenants = []
    for name in list_tenants():
        runtime = load_runtime(name)
        tenants.append(
            {
                "name": name,
                "status": container_status(name),
                "runtime": runtime,
            }
        )
    return JSONResponse({"tenants": tenants})


@app.get("/api/tenants/{tenant}/logs", response_class=PlainTextResponse)
def api_logs(tenant: str, tail: int = 200) -> PlainTextResponse:
    tenant = validate_tenant_name(tenant)
    tail_lines = str(max(1, min(tail, 2000)))
    command = ["docker", "logs", "--tail", tail_lines, f"xiaoba-{tenant}"]
    result = run_command(command, timeout=60)
    if result.returncode != 0:
        body = (result.stderr or result.stdout or "Failed to fetch logs").strip()
        raise HTTPException(status_code=400, detail=body)
    return PlainTextResponse(result.stdout or "(no logs)")


@app.post("/tenants/create")
def create_tenant(
    tenant_name: str = Form(...),
    cpus: str = Form(DEFAULT_RUNTIME["cpus"]),
    mem_limit: str = Form(DEFAULT_RUNTIME["mem_limit"]),
    pids_limit: str = Form(DEFAULT_RUNTIME["pids_limit"]),
) -> RedirectResponse:
    tenant = validate_tenant_name(tenant_name)
    ensure_tenant_scaffold(tenant)
    save_runtime(tenant, cpus, mem_limit, pids_limit)
    msg = quote_plus(f"Tenant {tenant} created")
    return RedirectResponse(
        url=f"/?tenant={tenant}&msg={msg}&level=ok",
        status_code=303,
    )


@app.post("/tenants/{tenant}/config")
def save_tenant_config(
    tenant: str,
    env_content: str = Form(...),
    cpus: str = Form(DEFAULT_RUNTIME["cpus"]),
    mem_limit: str = Form(DEFAULT_RUNTIME["mem_limit"]),
    pids_limit: str = Form(DEFAULT_RUNTIME["pids_limit"]),
) -> RedirectResponse:
    tenant = validate_tenant_name(tenant)
    ensure_tenant_scaffold(tenant)
    tenant_env_path(tenant).write_text(env_content.rstrip() + "\n", encoding="utf-8")
    save_runtime(tenant, cpus, mem_limit, pids_limit)
    msg = quote_plus("Config saved")
    return RedirectResponse(
        url=f"/?tenant={tenant}&msg={msg}&level=ok",
        status_code=303,
    )


@app.post("/tenants/{tenant}/action")
def tenant_action(
    tenant: str,
    action: str = Form(...),
    build: bool = Form(False),
) -> RedirectResponse:
    tenant = validate_tenant_name(tenant)
    ensure_tenant_scaffold(tenant)
    result = compose_action(tenant, action, build=build)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        msg = quote_plus(f"Action failed: {detail}")
        return RedirectResponse(
            url=f"/?tenant={tenant}&msg={msg}&level=error",
            status_code=303,
        )

    msg = quote_plus(f"Action {action} done")
    return RedirectResponse(
        url=f"/?tenant={tenant}&msg={msg}&level=ok",
        status_code=303,
    )
