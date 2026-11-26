// Drawplate Slewbox Native C++20 DSP Synthesizer CLI
// Zero external dependencies. Compile: clang++ -std=c++20 -O2 -o slewbox-cli slewbox_cli.cpp
// Renders 48 kHz 16-bit stereo PCM RIFF WAV files for saw, granular, fm, and sub patches.

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <numbers>
#include <string>
#include <vector>

namespace slewbox {

constexpr uint32_t kSampleRate = 48000;
constexpr uint16_t kChannels = 2;
constexpr size_t kTableSize = 2048;
constexpr size_t kTableMask = kTableSize - 1;
constexpr size_t kMaxGrains = 16;
constexpr double kTwoPi = 2.0 * std::numbers::pi;

enum class EngineType { Saw, Granular, Fm };

struct Patch {
  std::string id;
  EngineType engine = EngineType::Saw;
  double detuneCents = 11.0;
  double subLevel = 0.35;
  double grainSizeMs = 65.0;
  double grainDensity = 24.0;
  double pitchScatter = 0.18;
  double fmRatio = 3.5;
  double fmIndex = 4.8;
  double fmDecay = 0.42;
  double cutoff = 2400.0;
  double resonance = 0.38;
  double attack = 0.012;
  double decay = 0.22;
  double sustain = 0.68;
  double release = 0.28;
  double drive = 1.35;
  double gain = 0.72;
};

Patch presetById(const std::string& id) {
  if (id == "granular") {
    return Patch{"granular", EngineType::Granular, 6.0, 0.15, 68.0, 26.0, 0.18,
                 2.0, 1.5, 0.30, 3600.0, 0.22, 0.08, 0.35, 0.75, 0.45, 1.15, 0.76};
  }
  if (id == "fm") {
    return Patch{"fm", EngineType::Fm, 3.0, 0.0, 55.0, 18.0, 0.10,
                 3.5, 4.8, 0.42, 6200.0, 0.15, 0.004, 0.65, 0.14, 0.85, 1.10, 0.78};
  }
  if (id == "sub") {
    return Patch{"sub", EngineType::Saw, 4.0, 0.78, 60.0, 16.0, 0.08,
                 1.5, 1.2, 0.25, 680.0, 0.48, 0.008, 0.18, 0.72, 0.22, 1.55, 0.76};
  }
  return Patch{"saw", EngineType::Saw, 11.0, 0.35, 60.0, 20.0, 0.12,
               2.0, 2.0, 0.35, 2400.0, 0.38, 0.012, 0.22, 0.68, 0.28, 1.35, 0.72};
}

inline double polyBlep(double t, double dt) {
  if (t < dt) {
    const double x = t / dt;
    return x + x - x * x - 1.0;
  }
  if (t > 1.0 - dt) {
    const double x = (t - 1.0) / dt;
    return x * x + x + x + 1.0;
  }
  return 0.0;
}

inline double nextRand(uint32_t& state) {
  uint32_t x = state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  state = x;
  return static_cast<double>(x) / 4294967296.0;
}

struct Grain {
  bool active = false;
  double pos = 0.0;
  double age = 0.0;
  double dur = 1.0;
  double rate = 1.0;
  double pan = 0.5;
};

struct RenderResult {
  std::vector<int16_t> interleavedPcm;
  size_t numFrames = 0;
  double peak = 0.0;
  double renderMs = 0.0;
};

RenderResult renderPatch(const Patch& p, int midiNote, double durationSec) {
  const auto t0 = std::chrono::steady_clock::now();

  const size_t totalFrames = std::max<size_t>(1, static_cast<size_t>(durationSec * kSampleRate));
  const size_t relFrames = std::min<size_t>(
      static_cast<size_t>(p.release * kSampleRate), totalFrames * 4 / 10);
  const size_t gateOffFrame = (totalFrames > relFrames) ? (totalFrames - relFrames) : 1;

  std::array<double, kTableSize> table{};
  for (size_t i = 0; i < kTableSize; ++i) {
    const double ph = (static_cast<double>(i) / static_cast<double>(kTableSize)) * kTwoPi;
    table[i] = (0.52 * std::sin(ph) +
                0.24 * std::sin(ph * 2.0 + 0.4) +
                0.14 * std::sin(ph * 3.0 + 1.1) +
                0.08 * std::sin(ph * 5.0 + 0.7) +
                0.05 * std::sin(ph * 7.0 + 2.2) +
                0.03 * std::sin(ph * 11.0)) * 0.85;
  }

  const double baseFreq = 440.0 * std::pow(2.0, (midiNote - 69) / 12.0);
  const double detuneRatio = std::pow(2.0, p.detuneCents / 1200.0);
  const double incA = (baseFreq * detuneRatio) / kSampleRate;
  const double incB = (baseFreq / detuneRatio) / kSampleRate;
  const double incSub = (baseFreq * 0.5) / kSampleRate;
  const double carInc = baseFreq / kSampleRate;
  const double modInc = (baseFreq * p.fmRatio) / kSampleRate;

  double phaseA = 0.0, phaseB = 0.25, phaseSub = 0.0;
  double fmCar = 0.0, fmMod = 0.0, fmEnv = 1.0;
  const double fmDecayCoeff = std::exp(-1.0 / (std::max(0.02, p.fmDecay) * kSampleRate));

  std::array<Grain, kMaxGrains> grains{};
  double grainAccum = 1.0;
  uint32_t rng = 0x1337c0deu ^ static_cast<uint32_t>((midiNote + 1) * 2654435761u);

  const double clampedCut = std::clamp(p.cutoff, 60.0, kSampleRate * 0.22);
  const double f = std::min(0.85, 2.0 * std::sin((std::numbers::pi * clampedCut) / (kSampleRate * 2.0)));
  const double q = std::max(0.14, 1.0 - std::clamp(p.resonance, 0.0, 0.92));
  double lpL = 0.0, bpL = 0.0, lpR = 0.0, bpR = 0.0;

  const double atkStep = 1.0 / (std::max(0.001, p.attack) * kSampleRate);
  const double susLvl = std::clamp(p.sustain, 0.0, 1.0);
  const double decStep = (1.0 - susLvl) / (std::max(0.005, p.decay) * kSampleRate);
  const double relStep = std::max(susLvl, 0.01) / (std::max(0.005, p.release) * kSampleRate);
  int envStage = 1;
  double envVal = 0.0;

  const double outGain = std::clamp(p.gain * 0.85, 0.05, 1.0);

  std::vector<int16_t> pcm;
  pcm.resize(totalFrames * kChannels);
  double peak = 0.0;

  for (size_t i = 0; i < totalFrames; ++i) {
    if (i == gateOffFrame && envStage < 4) envStage = 4;

    if (envStage == 1) {
      envVal += atkStep;
      if (envVal >= 1.0) { envVal = 1.0; envStage = 2; }
    } else if (envStage == 2) {
      envVal -= decStep;
      if (envVal <= susLvl) { envVal = susLvl; envStage = 3; }
    } else if (envStage == 4) {
      envVal -= relStep;
      if (envVal < 0.0) envVal = 0.0;
    }

    double sigL = 0.0, sigR = 0.0;
    if (p.engine == EngineType::Granular) {
      grainAccum += std::clamp(p.grainDensity, 4.0, 80.0) / kSampleRate;
      if (grainAccum >= 1.0) {
        grainAccum -= 1.0;
        for (auto& g : grains) {
          if (!g.active) {
            g.active = true;
            g.age = 0.0;
            g.dur = std::max(64.0, p.grainSizeMs * 0.001 * kSampleRate);
            g.pos = nextRand(rng) * static_cast<double>(kTableSize);
            const double scatter = (nextRand(rng) * 2.0 - 1.0) * p.pitchScatter;
            g.rate = (baseFreq * std::pow(2.0, scatter) * kTableSize) / kSampleRate;
            g.pan = 0.15 + nextRand(rng) * 0.7;
            break;
          }
        }
      }
      double sumL = 0.0, sumR = 0.0;
      int activeCount = 0;
      for (auto& g : grains) {
        if (!g.active) continue;
        const double tNorm = g.age / g.dur;
        if (tNorm >= 1.0) { g.active = false; continue; }
        const double win = 0.5 - 0.5 * std::cos(kTwoPi * tNorm);
        const size_t idx0 = static_cast<size_t>(g.pos);
        const double frac = g.pos - static_cast<double>(idx0);
        const double s0 = table[idx0 & kTableMask];
        const double s1 = table[(idx0 + 1) & kTableMask];
        const double s = (s0 + (s1 - s0) * frac) * win;
        sumL += s * (1.0 - g.pan * 0.65);
        sumR += s * (0.35 + g.pan * 0.65);
        g.pos += g.rate;
        g.age += 1.0;
        ++activeCount;
      }
      const double norm = activeCount > 0 ? 1.0 / std::sqrt(activeCount + 1.0) : 1.0;
      sigL = sumL * norm;
      sigR = sumR * norm;
    } else if (p.engine == EngineType::Fm) {
      const double modVal = std::sin(fmMod * kTwoPi) * (p.fmIndex * fmEnv);
      fmEnv *= fmDecayCoeff;
      sigL = std::sin(fmCar * kTwoPi + modVal) * 0.72;
      sigR = std::sin((fmCar + 0.0018) * kTwoPi + modVal * 0.985) * 0.72;
      fmCar += carInc; if (fmCar >= 1.0) fmCar -= 1.0;
      fmMod += modInc; if (fmMod >= 1.0) fmMod -= 1.0;
    } else {
      const double sawA = 2.0 * phaseA - 1.0 - polyBlep(phaseA, incA);
      const double sawB = 2.0 * phaseB - 1.0 - polyBlep(phaseB, incB);
      const double sub = std::sin(phaseSub * kTwoPi) * p.subLevel;
      sigL = (sawA * 0.62 + sawB * 0.38) * 0.55 + sub * 0.45;
      sigR = (sawA * 0.38 + sawB * 0.62) * 0.55 + sub * 0.45;
      phaseA += incA; if (phaseA >= 1.0) phaseA -= 1.0;
      phaseB += incB; if (phaseB >= 1.0) phaseB -= 1.0;
      phaseSub += incSub; if (phaseSub >= 1.0) phaseSub -= 1.0;
    }

    for (int os = 0; os < 2; ++os) {
      const double hpL = sigL - lpL - q * bpL;
      bpL += f * hpL;
      lpL += f * bpL;
      const double hpR = sigR - lpR - q * bpR;
      bpR += f * hpR;
      lpR += f * bpR;
    }

    const double outL = std::clamp(std::tanh(lpL * envVal * p.drive) * outGain, -1.0, 1.0);
    const double outR = std::clamp(std::tanh(lpR * envVal * p.drive) * outGain, -1.0, 1.0);
    peak = std::max(peak, std::max(std::abs(outL), std::abs(outR)));

    pcm[i * 2] = static_cast<int16_t>(std::lround(outL * 32767.0));
    pcm[i * 2 + 1] = static_cast<int16_t>(std::lround(outR * 32767.0));
  }

  const auto t1 = std::chrono::steady_clock::now();
  const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
  return RenderResult{std::move(pcm), totalFrames, peak, ms};
}

bool writeWavFile(const std::string& path, const std::vector<int16_t>& pcm, size_t numFrames) {
  std::ofstream out(path, std::ios::binary);
  if (!out) return false;

  const uint16_t bitsPerSample = 16;
  const uint16_t blockAlign = kChannels * (bitsPerSample / 8);
  const uint32_t byteRate = kSampleRate * blockAlign;
  const uint32_t dataSize = static_cast<uint32_t>(numFrames * blockAlign);
  const uint32_t riffSize = 36 + dataSize;
  const uint32_t fmtSize = 16;
  const uint16_t audioFmt = 1;

  auto writeU32 = [&](uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
  auto writeU16 = [&](uint16_t v) { out.write(reinterpret_cast<const char*>(&v), 2); };

  out.write("RIFF", 4);
  writeU32(riffSize);
  out.write("WAVE", 4);
  out.write("fmt ", 4);
  writeU32(fmtSize);
  writeU16(audioFmt);
  writeU16(kChannels);
  writeU32(kSampleRate);
  writeU32(byteRate);
  writeU16(blockAlign);
  writeU16(bitsPerSample);
  out.write("data", 4);
  writeU32(dataSize);
  out.write(reinterpret_cast<const char*>(pcm.data()), dataSize);
  return static_cast<bool>(out);
}

}  // namespace slewbox

int main(int argc, char** argv) {
  std::string patchId = "saw";
  int midiNote = 60;
  double seconds = 1.5;
  std::string outPath = "slewbox-out.wav";
  double cutoffOverride = -1.0;
  double resOverride = -1.0;
  bool jsonOut = false;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--help" || arg == "-h") {
      std::cout << "slewbox-cli - Native C++20 48kHz DSP Synthesizer\n"
                << "Usage: slewbox-cli [--patch saw|granular|fm|sub] [--note 60] "
                << "[--seconds 1.5] [--cutoff Hz] [--resonance 0..0.9] [--out file.wav] [--json]\n";
      return 0;
    } else if (arg == "--patch" && i + 1 < argc) {
      patchId = argv[++i];
    } else if (arg == "--note" && i + 1 < argc) {
      midiNote = std::atoi(argv[++i]);
    } else if (arg == "--seconds" && i + 1 < argc) {
      seconds = std::max(0.05, std::min(30.0, std::atof(argv[++i])));
    } else if (arg == "--cutoff" && i + 1 < argc) {
      cutoffOverride = std::atof(argv[++i]);
    } else if (arg == "--resonance" && i + 1 < argc) {
      resOverride = std::atof(argv[++i]);
    } else if (arg == "--out" && i + 1 < argc) {
      outPath = argv[++i];
    } else if (arg == "--json") {
      jsonOut = true;
    }
  }

  auto patch = slewbox::presetById(patchId);
  if (cutoffOverride > 0.0) patch.cutoff = cutoffOverride;
  if (resOverride >= 0.0) patch.resonance = resOverride;

  const auto result = slewbox::renderPatch(patch, midiNote, seconds);
  if (!slewbox::writeWavFile(outPath, result.interleavedPcm, result.numFrames)) {
    std::cerr << "slewbox-cli: failed to write WAV file to " << outPath << "\n";
    return 1;
  }

  const size_t bytesWritten = 44 + result.numFrames * slewbox::kChannels * 2;
  if (jsonOut) {
    std::cout << std::fixed << std::setprecision(3)
              << "{\"patch\":\"" << patch.id << "\",\"note\":" << midiNote
              << ",\"sampleRate\":" << slewbox::kSampleRate
              << ",\"channels\":" << slewbox::kChannels
              << ",\"samples\":" << result.numFrames
              << ",\"bytes\":" << bytesWritten
              << ",\"peak\":" << result.peak
              << ",\"renderMs\":" << result.renderMs
              << ",\"out\":\"" << outPath << "\"}\n";
  } else {
    std::cout << std::fixed << std::setprecision(2)
              << "Rendered patch=" << patch.id
              << " note=" << midiNote
              << " samples=" << result.numFrames
              << " (" << slewbox::kSampleRate << "Hz stereo PCM16, " << bytesWritten << " bytes)"
              << " peak=" << std::setprecision(3) << result.peak
              << " in " << std::setprecision(2) << result.renderMs << " ms -> " << outPath << "\n";
  }
  return 0;
}
