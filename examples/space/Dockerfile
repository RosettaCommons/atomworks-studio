FROM python:3.12-slim
RUN python -m pip install --no-cache-dir "pip @ https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
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
