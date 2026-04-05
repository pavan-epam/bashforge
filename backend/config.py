from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Redis
    redis_url: str = "redis://redis:6379/0"

    # Session
    session_ttl_seconds: int = 3600           # 1 hour
    session_cookie_name: str = "bashforge_session"
    max_concurrent_sessions: int = 20

    # Kubernetes
    k8s_namespace:       str = "bashforge-sessions"
    k8s_sandbox_image:   str = "bashforge/sandbox:latest"
    # Path to kubeconfig on this machine; empty = in-cluster config
    kubeconfig_path:     str = ""
    # Internal hostname/IP of the K8s EC2 node accessible from this EC2
    k8s_node_ip:         str = ""

    # Security
    cookie_secret:       str = "CHANGE_ME_IN_PRODUCTION_32_CHARS_MIN"
    # Set to True in production to require HTTPS cookies
    secure_cookies:      bool = False         # set True when SSL is up

    # App
    cors_origins:        list[str] = ["http://localhost:3000"]
    debug:               bool = False
    mock_k8s:            bool = False         # for local dev without K8s


@lru_cache
def get_settings() -> Settings:
    return Settings()
