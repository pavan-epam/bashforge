"""
k8s_client.py  —  creates and deletes Kubernetes pods/services for each session.
Falls back to a mock mode (MOCK_K8S=true) for local development.
"""
import asyncio
import os
import logging
import secrets
import time
from typing import Optional

from config import get_settings

log = logging.getLogger(__name__)

# ── Lazy-import kubernetes SDK ────────────────────────────────────
_core_v1 = None

def _get_k8s() :
    global _core_v1
    if _core_v1 is not None:
        return _core_v1
    settings = get_settings()
    from kubernetes import client as k8s, config as k8s_config
    if settings.kubeconfig_path:
        k8s_config.load_kube_config(config_file=settings.kubeconfig_path)
    else:
        k8s_config.load_incluster_config()
    _core_v1 = k8s.CoreV1Api()
    return _core_v1


POD_MANIFEST_TEMPLATE = """\
apiVersion: v1
kind: Pod
metadata:
  name: {pod_name}
  namespace: {namespace}
  labels:
    app: bashforge-session
    session-id: "{session_id}"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 5
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: bash-session
    image: {image}
    imagePullPolicy: IfNotPresent
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: false
      capabilities:
        drop: ["ALL"]
    resources:
      requests:
        memory: "64Mi"
        cpu: "50m"
      limits:
        memory: "150Mi"
        cpu: "300m"
    ports:
    - containerPort: 8765
    volumeMounts:
    - name: workspace
      mountPath: /home/bashuser/workspace
    - name: tmp
      mountPath: /tmp
    env:
    - name: HOME
      value: /home/bashuser
    - name: SESSION_ID
      value: "{session_id}"
    - name: WS_TOKEN
      value: "{ws_token}"
  volumes:
  - name: workspace
    emptyDir:
      sizeLimit: "200Mi"
  - name: tmp
    emptyDir:
      sizeLimit: "20Mi"
"""

SVC_MANIFEST_TEMPLATE = """\
apiVersion: v1
kind: Service
metadata:
  name: {svc_name}
  namespace: {namespace}
  labels:
    session-id: "{session_id}"
spec:
  selector:
    session-id: "{session_id}"
  ports:
  - port: 8765
    targetPort: 8765
    protocol: TCP
  type: ClusterIP
"""


class MockK8sClient:
    """Used for local dev — no real Kubernetes required."""

    async def create_pod(self, session_id: str, pod_name: str, svc_name: str, ws_token: str) -> str:
        log.info("[MOCK K8s] Would create pod %s for session %s", pod_name, session_id)
        await asyncio.sleep(0.5)   # simulate startup
        return os.environ.get("MOCK_SANDBOX_HOST", "sandbox")  # Docker service name

    async def delete_pod(self, pod_name: str, svc_name: str) -> None:
        log.info("[MOCK K8s] Would delete pod %s", pod_name)

    async def pod_is_running(self, pod_name: str) -> bool:
        return True


class RealK8sClient:
    def __init__(self):
        self.settings = get_settings()

    def _load_yaml(self, text: str) -> dict:
        import yaml
        return yaml.safe_load(text)

    async def create_pod(self, session_id: str, pod_name: str, svc_name: str, ws_token: str) -> str:
        """Create Pod + Service. Returns the cluster IP of the service."""
        from kubernetes import client as k8s
        api = _get_k8s()
        ns  = self.settings.k8s_namespace

        # ── Create Pod ────────────────────────────────────────────
        pod_yaml = POD_MANIFEST_TEMPLATE.format(
            pod_name=pod_name,
            namespace=ns,
            session_id=session_id,
            image=self.settings.k8s_sandbox_image,
            ws_token=ws_token,
        )
        pod_body = self._load_yaml(pod_yaml)
        await asyncio.to_thread(
            api.create_namespaced_pod,
            namespace=ns,
            body=pod_body,
        )
        log.info("Created pod %s", pod_name)

        # ── Create Service ────────────────────────────────────────
        svc_yaml = SVC_MANIFEST_TEMPLATE.format(
            svc_name=svc_name,
            namespace=ns,
            session_id=session_id,
        )
        svc_body = self._load_yaml(svc_yaml)
        svc_obj  = await asyncio.to_thread(
            api.create_namespaced_service,
            namespace=ns,
            body=svc_body,
        )
        log.info("Created service %s", svc_name)

        # ── Wait for Pod Running (up to 30 s) ─────────────────────
        deadline = time.time() + 30
        while time.time() < deadline:
            pod = await asyncio.to_thread(
                api.read_namespaced_pod,
                name=pod_name,
                namespace=ns,
            )
            phase = pod.status.phase
            if phase == "Running":
                break
            if phase in ("Failed", "Succeeded"):
                raise RuntimeError(f"Pod entered unexpected phase: {phase}")
            await asyncio.sleep(1)
        else:
            raise TimeoutError(f"Pod {pod_name} did not become Running within 30s")

        # Return ClusterIP of the service
        cluster_ip = svc_obj.spec.cluster_ip
        log.info("Pod %s running, service ClusterIP=%s", pod_name, cluster_ip)
        return cluster_ip

    async def delete_pod(self, pod_name: str, svc_name: str) -> None:
        from kubernetes import client as k8s
        api = _get_k8s()
        ns  = self.settings.k8s_namespace

        for fn, name in [
            (api.delete_namespaced_pod,     pod_name),
            (api.delete_namespaced_service, svc_name),
        ]:
            try:
                await asyncio.to_thread(fn, name=name, namespace=ns)
                log.info("Deleted %s", name)
            except Exception as e:
                log.warning("Error deleting %s: %s", name, e)

    async def pod_is_running(self, pod_name: str) -> bool:
        api = _get_k8s()
        ns  = self.settings.k8s_namespace
        try:
            pod   = await asyncio.to_thread(api.read_namespaced_pod, name=pod_name, namespace=ns)
            return pod.status.phase == "Running"
        except Exception:
            return False


def get_k8s_client():
    s = get_settings()
    if s.mock_k8s:
        return MockK8sClient()
    return RealK8sClient()
