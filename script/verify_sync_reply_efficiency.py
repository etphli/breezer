#!/usr/bin/env python3
"""Compile the source-bound reply conversion against a small API type model.

This checks conversion values, validation and allocation ownership. It does not
compile Chromium, generated API headers, the service callback or native transport.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'features/sync/native/chrome/browser/sync/breezer_sync/provider_transport.cc'
BASELINE = ROOT / 'tests/sync/fixtures/provider-read-before.cc'
BASELINE_SHA = '73740e4fb244726bd3c8031cfd28f1d28dae510c3509383cf2ab06a96aaf5a42'
ORIGINAL_SOURCE_SHA = '3660bf9123234227399b3081d44cebcb48d1c6575e77e91bbd83265b751fe1eb'

CXX = r'''
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>
static bool measuring = false;
static std::size_t allocations = 0, allocated_bytes = 0;
void* operator new(std::size_t size) {
  if (measuring) { ++allocations; allocated_bytes += size; }
  if (void* memory = std::malloc(size ? size : 1)) return memory;
  throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete[](void* memory) noexcept { ::operator delete(memory); }
enum class Error { kInvalidData };
namespace base { Error unexpected(Error error) { return error; } }
namespace syncer {
struct OpaqueSyncVaultObject { std::vector<uint8_t> data; std::string revision; };
}
// ArrayBuffer/std::string ownership model, not generated Chromium API headers.
struct Success { std::optional<std::vector<uint8_t>> data; std::optional<std::string> revision; };
struct Reply { std::optional<Success> success; };
using Response = std::optional<std::optional<Reply>>;
using Result = std::variant<syncer::OpaqueSyncVaultObject, Error>;
Result baseline(Response response, std::size_t maximum) {
@BASELINE@
}
Result current(Response response, std::size_t maximum) {
@CURRENT@
}
struct Stats { std::size_t allocations = 0, bytes = 0, transfers = 0; };
static Stats stats[2];
static std::size_t cases = 0, nonempty_successes = 0;
void check(std::size_t size, std::size_t maximum, int invalid = 0) {
  const std::vector<uint8_t> expected(size, uint8_t{0xa7});
  const std::string revision(128, 'r');
  const bool valid = invalid == 0 && size <= maximum;
  ++cases;
  if (valid && size) ++nonempty_successes;
  for (int mode = 0; mode < 2; ++mode) {
    Response response;
    response.emplace(); response->emplace();
    auto& success = response->value().success.emplace();
    if (invalid != 1) success.data = expected;
    if (invalid != 2) success.revision = invalid == 3 ? std::string{} : revision;
    const auto address = success.data ? reinterpret_cast<std::uintptr_t>(success.data->data()) : 0;
    allocations = allocated_bytes = 0;
    measuring = true;
    Result result = mode == 0 ? baseline(std::move(response), maximum) : current(std::move(response), maximum);
    measuring = false;
    stats[mode].allocations += allocations;
    stats[mode].bytes += allocated_bytes;
    if (valid) {
      const auto* object = std::get_if<syncer::OpaqueSyncVaultObject>(&result);
      if (!object || object->data != expected || object->revision != revision) throw std::runtime_error("Changed success value");
      if (size && reinterpret_cast<std::uintptr_t>(object->data.data()) == address) ++stats[mode].transfers;
    } else if (!std::holds_alternative<Error>(result) || std::get<Error>(result) != Error::kInvalidData) {
      throw std::runtime_error("Changed rejection");
    }
  }
}
int main() {
  try {
    for (std::size_t size : {0u, 1u, 256u, 1048576u, 2097152u}) {
      check(size, size);
      if (size) check(size, size - 1);
    }
    for (int invalid : {1, 2, 3}) check(256, 256, invalid);
    std::cout << "{\"cases\":" << cases << ",\"nonemptySuccesses\":" << nonempty_successes;
    for (int mode = 0; mode < 2; ++mode) {
      std::cout << (mode ? ",\"current\":{" : ",\"baseline\":{")
        << "\"allocations\":" << stats[mode].allocations << ",\"allocatedBytes\":" << stats[mode].bytes
        << ",\"dataTransfers\":" << stats[mode].transfers << "}";
    }
    std::cout << ",\"valuesAndRejectionsPreserved\":true}\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
'''


def verify(source_path=SOURCE, expect_moved=False):
    source = source_path.read_text()
    before = BASELINE.read_text()
    if hashlib.sha256(before.encode()).hexdigest() != BASELINE_SHA:
        raise ValueError('Pinned conversion baseline changed')
    before = before.rstrip('\n')
    match = re.search(r'^    (?:const )?auto& success = \*response->value\(\)\.success;', source, re.M)
    if not match:
        raise ValueError('Read conversion anchor changed')
    start = match.start()
    end = source.index('\n  }\n\n  WriteResult', start)
    moved = before.replace('const auto& success', 'auto& success', 1).replace(
        '{*success.data, *success.revision}',
        '{std::move(*success.data),\n                                       std::move(*success.revision)}')
    if source[start:end] not in (before, moved):
        raise ValueError('Conversion differs from the audited copy/transfer forms')
    restored = source[:start] + before + source[end:]
    if hashlib.sha256(restored.encode()).hexdigest() != ORIGINAL_SOURCE_SHA:
        raise ValueError('Source outside the audited conversion changed')
    compiler = shutil.which('clang++') or shutil.which('g++')
    if not compiler:
        raise RuntimeError('A local C++ compiler is required for this diagnostic')
    work = ROOT / 'build/efficiency-20261103'
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sync-reply-check-', dir=work) as directory:
        program, binary = Path(directory) / 'reply.cc', Path(directory) / 'reply-check'
        program.write_text(CXX.replace('@BASELINE@', before).replace('@CURRENT@', source[start:end]))
        command = [compiler, '-std=c++17', '-O0', '-fno-modules', '-Wall', '-Wextra', '-Werror', str(program), '-o', str(binary)]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        result = json.loads(subprocess.check_output([str(binary)], text=True, timeout=10))
    result.update(sourceSha256=hashlib.sha256(source.encode()).hexdigest(), baselineSourceSha256=ORIGINAL_SOURCE_SHA,
                  conversionBaselineSha256=BASELINE_SHA, compiler=compiler,
                  scope='Actual conversion text compiled with a small API type model. Not a full generated-header/Chromium/native-provider build; allocation counts are fixture values, not physical RAM or steady-state browser savings.')
    if expect_moved and (result['current']['allocations'] != 0 or result['current']['dataTransfers'] != result['nonemptySuccesses']):
        raise AssertionError('Current conversion still copies the reply payload/revision')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--expect-moved', action='store_true')
    args = parser.parse_args()
    result = verify(args.source, args.expect_moved)
    text = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text, end='')


if __name__ == '__main__':
    main()
