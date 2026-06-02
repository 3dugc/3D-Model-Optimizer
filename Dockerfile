# 三维模型优化服务 - 支持 KTX2, USDZ, FBX, STEP 和 DAE
# The optional conversion toolchain currently depends on linux/amd64 binaries
# and PyPI wheels (KTX, FBX2glTF, COLLADA2GLTF, usd-core).
ARG RUNTIME_PLATFORM=linux/amd64
FROM --platform=${RUNTIME_PLATFORM} node:20-bookworm-slim

# Install dependencies for KTX-Software, Python (for USD/STEP), and FBX2glTF
RUN apt-get update && apt-get install -y \
    wget \
    cmake \
    build-essential \
    git \
    libzstd-dev \
    libxrender1 \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
    libgl1-mesa-glx \
    libglu1-mesa \
    && rm -rf /var/lib/apt/lists/*

# Download and install pre-built KTX-Software (toktx)
RUN wget --tries=3 --timeout=60 -q https://github.com/KhronosGroup/KTX-Software/releases/download/v4.3.2/KTX-Software-4.3.2-Linux-x86_64.tar.bz2 \
    && tar -xjf KTX-Software-4.3.2-Linux-x86_64.tar.bz2 \
    && cp KTX-Software-4.3.2-Linux-x86_64/bin/* /usr/local/bin/ \
    && cp -r KTX-Software-4.3.2-Linux-x86_64/lib/* /usr/local/lib/ \
    && ldconfig \
    && rm -rf KTX-Software-4.3.2-Linux-x86_64* \
    && toktx --version \
    || echo "WARNING: KTX-Software installation failed, texture compression will not be available"

# Download and install FBX2glTF
RUN wget --tries=3 --timeout=60 -q https://github.com/godotengine/FBX2glTF/releases/download/v0.13.1/FBX2glTF-linux-x86_64.zip \
    && unzip FBX2glTF-linux-x86_64.zip \
    && chmod +x FBX2glTF-linux-x86_64/FBX2glTF-linux-x86_64 \
    && mv FBX2glTF-linux-x86_64/FBX2glTF-linux-x86_64 /usr/local/bin/FBX2glTF \
    && rm -rf FBX2glTF-linux-x86_64 FBX2glTF-linux-x86_64.zip \
    && FBX2glTF --help \
    || echo "WARNING: FBX2glTF installation failed, FBX conversion will not be available"

# Download and install COLLADA2GLTF for DAE conversion
RUN wget --tries=3 --timeout=60 -q https://github.com/KhronosGroup/COLLADA2GLTF/releases/download/v2.1.5/COLLADA2GLTF-v2.1.5-linux.zip \
    && unzip COLLADA2GLTF-v2.1.5-linux.zip \
    && chmod +x COLLADA2GLTF-bin \
    && mv COLLADA2GLTF-bin /usr/local/bin/COLLADA2GLTF \
    && rm -rf COLLADA2GLTF-v2.1.5-linux.zip \
    && (COLLADA2GLTF --help || true) \
    || echo "WARNING: COLLADA2GLTF installation failed, DAE conversion will not be available"

# Install Python packages for USDZ conversion. Keep this required so Docker
# builds fail loudly if USDZ support is unavailable.
RUN pip3 install --break-system-packages --no-cache-dir \
    numpy \
    trimesh \
    usd-core \
    && python3 -c "from pxr import Usd; import numpy; import trimesh; print('USD installed successfully')"

ARG INSTALL_CAD_SUPPORT=true
ARG CAD_INSTALL_TIMEOUT_SECONDS=1200

# Install Python packages for STEP/CAD conversion. Keep this required so Docker
# builds fail loudly if STEP support is unavailable.
RUN if [ "$INSTALL_CAD_SUPPORT" = "true" ]; then \
      timeout "${CAD_INSTALL_TIMEOUT_SECONDS}s" pip3 install --break-system-packages --no-cache-dir --default-timeout=600 --retries=10 \
        cadquery \
      && python3 -c "import cadquery; import OCP; print('CAD packages installed successfully')"; \
    else \
      echo "Skipping optional CAD Python packages; STEP/CAD conversion will not be available"; \
    fi

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --cache /tmp/.npm-cache

# Copy source code
COPY . .

# Build TypeScript, then keep only runtime dependencies
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

# Create temp directories
RUN mkdir -p temp/uploads temp/results

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "dist/index.js"]
