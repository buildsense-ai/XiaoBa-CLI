from setuptools import setup, find_packages

setup(
    name="catscompany-bot",
    version="0.2.0",
    description="Cats Company Bot SDK - build bots that connect via WebSocket",
    packages=find_packages(),
    install_requires=[
        "websocket-client>=1.6.0",
    ],
    python_requires=">=3.9",
)
