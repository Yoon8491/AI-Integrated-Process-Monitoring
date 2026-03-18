from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import PORT, CORS_ORIGIN
from routers import auth_router, dashboard_router, grafana_webhook

app = FastAPI(title="AZAS Dashboard API", version="1.0.0")

origins = [o.strip() for o in CORS_ORIGIN.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(auth_router.router)
app.include_router(dashboard_router.router)
app.include_router(grafana_webhook.router)


@app.get("/health")
async def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
