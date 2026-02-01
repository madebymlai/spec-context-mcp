#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

os_id=""
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  os_id="${ID:-}"
fi

if [[ -z "${os_id}" ]]; then
  uname_out="$(uname -s | tr '[:upper:]' '[:lower:]')"
  if [[ "${uname_out}" == "darwin" ]]; then
    os_id="darwin"
  fi
fi

case "${os_id}" in
  fedora|rhel|centos)
    ${SUDO} dnf -y install \
      python3-devel \
      gcc gcc-c++ make \
      cmake ninja-build \
      git swig
    ;;
  ubuntu|debian|linuxmint)
    ${SUDO} apt-get update
    ${SUDO} apt-get -y install \
      python3-dev \
      build-essential \
      cmake ninja-build \
      git swig
    ;;
  darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew is required on macOS. Install from https://brew.sh" >&2
      exit 1
    fi
    brew install cmake ninja swig git
    ;;
  *)
    echo "Unsupported OS. Install build deps manually:" >&2
    echo "  Python headers (python3-dev/python3-devel), C++ compiler, cmake, ninja, git, swig" >&2
    exit 1
    ;;
esac

if command -v swig >/dev/null 2>&1; then
  if ! PYTHONNOUSERSITE=1 swig -version >/dev/null 2>&1; then
    echo "WARNING: 'swig' in PATH fails under PYTHONNOUSERSITE=1 (pip build isolation)." >&2
    echo "         If rapidyaml builds fail, ensure a real system swig binary is used (avoid ~/.local/bin/swig wrappers)." >&2
  fi
fi
