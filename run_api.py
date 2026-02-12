#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os

import uvicorn


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run XiaoBa admin API (FastAPI).",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8001, help="Bind port (default: 18080)")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for local development",
    )
    parser.add_argument(
        "--admin-user",
        default=None,
        help="Optional admin username (sets XIAOBA_ADMIN_USER)",
    )
    parser.add_argument(
        "--admin-password",
        default=None,
        help="Optional admin password (sets XIAOBA_ADMIN_PASSWORD)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.admin_user is not None:
        os.environ["XIAOBA_ADMIN_USER"] = args.admin_user
    if args.admin_password is not None:
        os.environ["XIAOBA_ADMIN_PASSWORD"] = args.admin_password

    uvicorn.run(
        "deploy.admin.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
