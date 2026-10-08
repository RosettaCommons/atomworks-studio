FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 studio
COPY wheels/ /tmp/wheels/
RUN pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --find-links=/tmp/wheels /tmp/wheels/atomworks_studio-*.whl \
    && pip check && rm -rf /tmp/wheels
USER studio
WORKDIR /home/studio
ENV ANNOTATION_STUDIO_FRAME_ANCESTORS="'self' https://huggingface.co"
EXPOSE 7860
CMD ["atomworks-studio", "--host", "0.0.0.0", "--port", "7860"]
