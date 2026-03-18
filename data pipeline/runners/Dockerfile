FROM n8nio/runners:2.4.8

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential gfortran libopenblas-dev liblapack-dev \
  && rm -rf /var/lib/apt/lists/*
RUN cd /opt/runners/task-runner-python \
  && uv pip install numpy pandas scikit-learn

COPY n8n-task-runners.json /etc/n8n-task-runners.json

USER runner
