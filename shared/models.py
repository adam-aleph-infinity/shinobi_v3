"""Core data models shared across all stages."""
import json
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path


@dataclass
class TranscriptResult:
    """Result from a single transcription engine."""
    engine: str
    text: str
    words: List[Dict[str, Any]]
    segments: Optional[List[Dict[str, Any]]] = None
    logprobs: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None
    duration: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "engine": self.engine,
            "text": self.text,
            "words": self.words,
            "segments": self.segments,
            "logprobs": self.logprobs,
            "metadata": self.metadata,
            "duration": self.duration,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TranscriptResult":
        return cls(
            engine=data["engine"],
            text=data["text"],
            words=data["words"],
            segments=data.get("segments"),
            logprobs=data.get("logprobs"),
            metadata=data.get("metadata"),
            duration=data.get("duration", 0.0),
        )


@dataclass
class StageManifest:
    """Contract between pipeline stages. Serialized as JSON between stages."""
    job_id: str
    audio_path: str
    speakers: Tuple[str, str]
    workspace_dir: str
    config: Dict[str, Any] = field(default_factory=dict)

    # Stage 0101 outputs (Voice DNA)
    voice_dna_report_path: Optional[str] = None
    voice_dna_json_path: Optional[str] = None
    voice_dna_profiles_dir: Optional[str] = None

    # Stage 1 outputs
    audio_variants: Optional[Dict[str, str]] = None

    # Stage 2 outputs
    transcript_results_paths: Optional[Dict[str, str]] = None
    diarization_results_paths: Optional[List[str]] = None

    # Stage 3 outputs
    speaker_map: Optional[Dict[str, str]] = None
    speaker_assigned_words_path: Optional[str] = None

    # Stage 4 outputs
    voted_words_path: Optional[str] = None
    corrections_path: Optional[str] = None
    final_srt_path: Optional[str] = None
    text_only_consensus_path: Optional[str] = None

    # Stage 5 outputs
    ground_truth_path: Optional[str] = None
    evaluation_report_path: Optional[str] = None
    analysis_report_path: Optional[str] = None

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "job_id": self.job_id,
            "audio_path": self.audio_path,
            "speakers": list(self.speakers),
            "workspace_dir": self.workspace_dir,
            "config": self.config,
            "voice_dna_report_path": self.voice_dna_report_path,
            "voice_dna_json_path": self.voice_dna_json_path,
            "voice_dna_profiles_dir": self.voice_dna_profiles_dir,
            "audio_variants": self.audio_variants,
            "transcript_results_paths": self.transcript_results_paths,
            "diarization_results_paths": self.diarization_results_paths,
            "speaker_map": self.speaker_map,
            "speaker_assigned_words_path": self.speaker_assigned_words_path,
            "voted_words_path": self.voted_words_path,
            "corrections_path": self.corrections_path,
            "final_srt_path": self.final_srt_path,
            "text_only_consensus_path": self.text_only_consensus_path,
            "ground_truth_path": self.ground_truth_path,
            "evaluation_report_path": self.evaluation_report_path,
            "analysis_report_path": self.analysis_report_path,
        }
        with open(path, "w") as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load(cls, path: str | Path) -> "StageManifest":
        with open(path) as f:
            data = json.load(f)
        return cls(
            job_id=data["job_id"],
            audio_path=data["audio_path"],
            speakers=tuple(data["speakers"]),
            workspace_dir=data["workspace_dir"],
            config=data.get("config", {}),
            voice_dna_report_path=data.get("voice_dna_report_path"),
            voice_dna_json_path=data.get("voice_dna_json_path"),
            voice_dna_profiles_dir=data.get("voice_dna_profiles_dir"),
            audio_variants=data.get("audio_variants"),
            transcript_results_paths=data.get("transcript_results_paths"),
            diarization_results_paths=data.get("diarization_results_paths"),
            speaker_map=data.get("speaker_map"),
            speaker_assigned_words_path=data.get("speaker_assigned_words_path"),
            voted_words_path=data.get("voted_words_path"),
            corrections_path=data.get("corrections_path"),
            final_srt_path=data.get("final_srt_path"),
            text_only_consensus_path=data.get("text_only_consensus_path"),
            ground_truth_path=data.get("ground_truth_path"),
            evaluation_report_path=data.get("evaluation_report_path"),
            analysis_report_path=data.get("analysis_report_path"),
        )

    @classmethod
    def from_standalone(cls, audio_path: str, workspace_dir: str, speakers: Tuple[str, str] = ("Ron", "Chris"), config: Optional[Dict] = None) -> "StageManifest":
        """Create a minimal manifest for standalone stage execution."""
        from datetime import datetime
        job_id = f"{Path(audio_path).stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        return cls(
            job_id=job_id,
            audio_path=str(Path(audio_path).resolve()),
            speakers=speakers,
            workspace_dir=str(Path(workspace_dir).resolve()),
            config=config or {},
        )
