file(GLOB_RECURSE sources ./**/*.cpp ./**/*.c)
list(FILTER sources EXCLUDE REGEX "lex_data_include*")

idf_component_register(SRCS "${sources}" INCLUDE_DIRS "include")

target_compile_definitions(${COMPONENT_LIB} PRIVATE CST_USER_MALLOC)

# Project builds with -Os to fit the app partition; flite's code is small (~70KB) and
# synthesis speed matters, so keep it at -O2. Its 4.5MB of voice data is unaffected either way.
target_compile_options(${COMPONENT_LIB} PRIVATE -O2)
