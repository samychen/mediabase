# xmedia-bridge — the product-owned sidecar executable.
#
# This is an INDEPENDENT CMake project. It does not patch, fork or vendor
# xmedia-kit: it consumes the SDK exactly the way an external host would,
# through one of two supported seams:
#
#   A) installed SDK (recommended, seconds to build):
#        cmake --install <xmedia-kit-build> --prefix <prefix>
#        cmake -S . -B build -DXMEDIA_KIT_DIR=<prefix>
#      → find_package(xmedia-kit CONFIG) + exported xmedia::player
#        (the only exported target; it carries the media/FFmpeg dependencies)
#
#   B) source tree (no install step, rebuilds the SDK):
#        cmake -S . -B build -DXMEDIA_KIT_SOURCE_DIR=/path/to/xmedia-kit
#      → add_subdirectory + the in-tree umbrella target xmedia::xmedia-kit
#        (the same target examples/ links against)
#
# The bridge only uses media::TranscodeJob — no Player, no window system. The
# umbrella/player target is still linked because it is the SDK's dependency
# carrier for the transcode archive, not because playback is involved.
#
# FFmpeg/libyuv are found by the modules shipped inside the installed package.
# If they live in a custom prefix (xmedia-kit's tools/build convention), pass
# -DXMEDIA_FFMPEG_ROOT=<deps-prefix>; -DXMEDIA_DEPS_LIBDIR=<deps-prefix>/lib
# adds the runtime rpath for the dylibs.
#
# Build:  cmake -S . -B build -DXMEDIA_KIT_DIR=... && cmake --build build
# Smoke:  ctest --test-dir build --output-on-failure

cmake_minimum_required(VERSION 3.20)
# C is enabled (even though the bridge is C++): the installed FindFFmpeg.cmake
# performs a try_run() against a .c version probe, and try_compile only accepts
# files whose language the project enabled.
project(xmedia-mediabase-bridge LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(XMEDIA_KIT_DIR "" CACHE PATH "install prefix of xmedia-kit (find_package mode)")
set(XMEDIA_KIT_SOURCE_DIR "" CACHE PATH "xmedia-kit source tree (add_subdirectory mode)")
set(XMEDIA_FFMPEG_ROOT "" CACHE PATH "custom FFmpeg/libyuv prefix")
set(XMEDIA_DEPS_LIBDIR "" CACHE PATH "directory holding the FFmpeg/libyuv dylibs (runtime rpath)")

if(NOT XMEDIA_KIT_DIR AND NOT XMEDIA_KIT_SOURCE_DIR AND NOT DEFINED xmedia-kit_DIR)
  message(FATAL_ERROR
      "Set XMEDIA_KIT_DIR (installed SDK prefix), XMEDIA_KIT_SOURCE_DIR "
      "(source tree), or xmedia-kit_DIR (package config directory).")
endif()

if(XMEDIA_KIT_SOURCE_DIR)
  # In-tree consumption. Gate the heavy optional layers off: the bridge needs
  # the transcode/FFmpeg pipeline, not tests, examples or a window system.
  set(XMEDIA_ENABLE_FFMPEG ON CACHE BOOL "" FORCE)
  set(XMEDIA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(XMEDIA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(XMEDIA_ENABLE_SDL2 OFF CACHE BOOL "" FORCE)
  set(XMEDIA_ENABLE_CAPI OFF CACHE BOOL "" FORCE)
  # xmedia-kit's targets declare their include root as
  #   $<BUILD_INTERFACE:${CMAKE_SOURCE_DIR}>
  # which is the SDK root only when it is the TOP-LEVEL project. Under
  # add_subdirectory() CMAKE_SOURCE_DIR points at THIS bridge's source dir, so
  # every "render/gl/*.h" / "base/*.h" include fails to resolve. Re-establish
  # the SDK root from the parent scope: directory-level includes are inherited
  # by subdirectories. (Upstream should use PROJECT_SOURCE_DIR here; we do not
  # patch the SDK.) Keep this above add_subdirectory().
  include_directories("${XMEDIA_KIT_SOURCE_DIR}")
  add_subdirectory("${XMEDIA_KIT_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/xmedia-kit")
  # The transcode product line is an OPT-IN target (media/CMakeLists decision
  # D11): the umbrella xmedia::xmedia-kit alone does not export transcode, so a
  # host that encodes must link xmedia::transcode explicitly. Without it the
  # bridge fails at link time on media::TranscodeJob.
  set(XMEDIA_BRIDGE_LIBS xmedia::xmedia-kit xmedia::transcode)
else()
  if(XMEDIA_KIT_DIR)
    list(PREPEND CMAKE_PREFIX_PATH "${XMEDIA_KIT_DIR}")
  endif()
  find_package(xmedia-kit CONFIG REQUIRED)
  # xmedia::xmedia-kit is an in-tree ALIAS and is deliberately NOT exported
  # (cmake/XmediaInstall.cmake). An installed consumer links the exported
  # xmedia::player, whose INTERFACE_LINK_LIBRARIES already pull media/ffmpeg.
  # xmedia_transcode is installed but NOT exported either, so resolve its
  # archive directly (XmediaInstall.cmake installs it into <prefix>/lib).
  find_library(XMEDIA_TRANSCODE_LIBRARY
      NAMES xmedia_transcode libxmedia_transcode
      PATHS "${XMEDIA_KIT_DIR}/lib" "${XMEDIA_KIT_DIR}/lib64"
      NO_DEFAULT_PATH)
  if(NOT XMEDIA_TRANSCODE_LIBRARY)
    message(FATAL_ERROR
        "libxmedia_transcode not found under ${XMEDIA_KIT_DIR}/lib. "
        "Install an SDK build configured with XMEDIA_ENABLE_FFMPEG=ON.")
  endif()
  set(XMEDIA_BRIDGE_LIBS xmedia::player "${XMEDIA_TRANSCODE_LIBRARY}")
endif()

# The wire protocol header is GENERATED from protocol/contract.json (the single
# source of truth). Regenerate it when Node is available; otherwise the committed
# copy is used, so the C++ build never hard-requires Node.
find_program(NODE_EXECUTABLE node)
if(NODE_EXECUTABLE)
  add_custom_command(
    OUTPUT ${CMAKE_CURRENT_SOURCE_DIR}/src/xmedia_protocol.h
    COMMAND ${NODE_EXECUTABLE}
            ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/gen-protocol.mjs
            ${CMAKE_CURRENT_SOURCE_DIR}/../protocol/contract.json
            ${CMAKE_CURRENT_SOURCE_DIR}/src/xmedia_protocol.h
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../protocol/contract.json
            ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/gen-protocol.mjs
    COMMENT "Regenerating xmedia_protocol.h from protocol/contract.json"
    VERBATIM)
endif()

add_executable(xmedia-bridge
  src/mediabase_bridge.cc
  src/sandbox.cc
  src/xmedia_protocol.h)
target_link_libraries(xmedia-bridge PRIVATE ${XMEDIA_BRIDGE_LIBS})
# The SDK is built -fno-exceptions -fno-rtti (Google/Chromium convention).
# Match it in the consumer TU so the whole process shares one error model.
target_compile_options(xmedia-bridge PRIVATE -fno-exceptions -fno-rtti)

if(XMEDIA_DEPS_LIBDIR)
  set_target_properties(xmedia-bridge PROPERTIES
      BUILD_RPATH "${XMEDIA_DEPS_LIBDIR}"
      INSTALL_RPATH "${XMEDIA_DEPS_LIBDIR}")
endif()

enable_testing()
add_test(NAME xmedia-bridge.line-protocol
    COMMAND "${CMAKE_COMMAND}"
            "-DBRIDGE_BIN=$<TARGET_FILE:xmedia-bridge>"
            "-P" "${CMAKE_CURRENT_SOURCE_DIR}/cmake/smoke.cmake")
