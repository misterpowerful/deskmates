file(GLOB_RECURSE LIBS "lib/*/src/**.cpp" "lib/*/src/**.c")

file(GLOB_RECURSE SOURCES
        "${CMAKE_CURRENT_SOURCE_DIR}/src/**.cpp"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/**.hpp"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/**.c"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/**.h"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/*/**.cpp"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/*/**.hpp"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/*/**.c"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/*/**.h"
        "${CMAKE_CURRENT_SOURCE_DIR}/main.cpp")

# Gatsby-voice startup/goodbye lines (src/Audio/GatsbyLines.cpp)
file(GLOB GATSBY_LINES "${CMAKE_CURRENT_SOURCE_DIR}/assets/gatsby/*.aac")
idf_component_register(SRCS ${SOURCES} ${LIBS} INCLUDE_DIRS "src" EMBED_FILES ${GATSBY_LINES})

# Create the PHY PLL-track timer once instead of on every BLE wake (see src/Net/PhyPllTrack.c).
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=phy_track_pll_init" "-Wl,--wrap=phy_track_pll_deinit")
# Nothing in main references the __wrap_ symbols, so force PhyPllTrack.c.obj into the link.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-u __wrap_phy_track_pll_init" "-u __wrap_phy_track_pll_deinit")

# Project builds with -Os to fit the app partition; keep the per-sample audio DSP at -O2.
file(GLOB AUDIO_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/Audio/*.cpp")
set_source_files_properties(${AUDIO_SOURCES} PROPERTIES COMPILE_OPTIONS "-O2")

spiffs_create_partition_image(storage ../spiffs FLASH_IN_PROJECT)

idf_build_get_property(BASEDIR PROJECT_DIR)
esptool_py_flash_to_partition(flash objdet ${BASEDIR}/models/objdet.tflite)
