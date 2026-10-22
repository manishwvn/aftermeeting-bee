from __future__ import annotations

import copy
import http.client
import json
import subprocess
import threading
import unittest
from pathlib import Path
from typing import Any

import app


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "bee-conversation-fixture-only.json"
FIXTURE_ENVELOPE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
FIXTURE = FIXTURE_ENVELOPE["conversation"]
FIXTURE_ID = FIXTURE["id"]


class FakeBee:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.detail = app.normalize_conversation_detail(FIXTURE_ENVELOPE, FIXTURE_ID, json.dumps(FIXTURE_ENVELOPE))

    def list_conversations(self) -> dict[str, Any]:
        self.calls.append(("list", None))
        return {
            "conversations": [
                {
                    "id": FIXTURE_ID,
                    "start_time": FIXTURE["start_time"],
                    "end_time": FIXTURE["end_time"],
                    "created_at": FIXTURE["created_at"],
                    "summary": FIXTURE["summary"],
                    "state": FIXTURE["state"],
                }
            ],
            "next_cursor": None,
            "timezone": "America/Chicago",
        }

    def get_conversation(self, conversation_id: Any) -> dict[str, Any]:
        self.calls.append(("get", conversation_id))
        if conversation_id != FIXTURE_ID:
            raise app.AppError(404, "bee_conversation_missing", "Bee did not return that conversation.")
        return {**self.detail, "candidates": app.extract_candidates(self.detail)}


class BeeCliTests(unittest.TestCase):
    def test_list_uses_only_the_fixed_official_read_command(self) -> None:
        calls: list[tuple[list[str], dict[str, Any]]] = []
        payload = {
            "conversations": [
                {
                    "id": 2,
                    "start_time": 1_771_000_000_000,
                    "end_time": None,
                    "created_at": 1_771_000_000_000,
                    "summary": "A private summary is received in memory.",
                    "state": "COMPLETED",
                }
            ],
            "next_cursor": None,
            "timezone": "UTC",
        }

        def runner(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        client = app.BeeCLI(executable="fixture-bee", runner=runner)
        data = client.list_conversations()
        self.assertEqual(data["conversations"][0]["id"], 2)
        self.assertEqual(calls[0][0], ["fixture-bee", "conversations", "list", "--limit", "10", "--json"])
        self.assertIs(calls[0][1]["shell"], False)
        self.assertIs(calls[0][1]["stdin"], subprocess.DEVNULL)
        self.assertEqual(calls[0][1]["timeout"], app.CLI_TIMEOUT_SECONDS)

    def test_get_uses_selected_numeric_id_and_rejects_injection_before_runner(self) -> None:
        calls: list[list[str]] = []
        raw = json.dumps(FIXTURE_ENVELOPE)

        def runner(args: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, raw, "")

        client = app.BeeCLI(executable="fixture-bee", runner=runner)
        result = client.get_conversation(FIXTURE_ID)
        self.assertEqual(calls[0], ["fixture-bee", "conversations", "get", str(FIXTURE_ID), "--json"])
        self.assertEqual(result["source_response_sha256"], app.hashlib.sha256(raw.encode()).hexdigest())
        with self.assertRaises(app.AppError) as caught:
            client.get_conversation("1; touch /tmp/unwanted")
        self.assertEqual(caught.exception.code, "invalid_conversation_id")
        self.assertEqual(len(calls), 1)

    def test_login_error_is_redacted(self) -> None:
        def runner(args: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(args, 1, "", "Not logged in. token=example-secret")

        with self.assertRaises(app.AppError) as caught:
            app.BeeCLI(executable="fixture-bee", runner=runner).list_conversations()
        self.assertEqual(caught.exception.code, "bee_login_required")
        self.assertNotIn("example-secret", caught.exception.message)

    def test_oversize_cli_output_is_rejected(self) -> None:
        def runner(args: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(args, 0, " " * (app.MAX_OUTPUT_BYTES + 1), "")

        with self.assertRaises(app.AppError) as caught:
            app.BeeCLI(executable="fixture-bee", runner=runner).list_conversations()
        self.assertEqual(caught.exception.code, "bee_response_too_large")


class ContractAndExtractionTests(unittest.TestCase):
    def test_list_contract_preserves_ids_timestamps_and_limit(self) -> None:
        result = app.normalize_conversation_list(
            {
                "conversations": [
                    {
                        "id": FIXTURE_ID,
                        "start_time": FIXTURE["start_time"],
                        "end_time": FIXTURE["end_time"],
                        "created_at": FIXTURE["created_at"],
                        "summary": FIXTURE["summary"],
                        "state": "COMPLETED",
                    }
                ],
                "next_cursor": None,
                "timezone": "America/Chicago",
                "ignored_private_field": "not returned to browser",
            }
        )
        self.assertEqual(result["conversations"][0]["start_time"], FIXTURE["start_time"])
        self.assertNotIn("ignored_private_field", result)

    def test_exact_source_quote_and_speaker_are_preserved(self) -> None:
        raw = json.dumps(FIXTURE_ENVELOPE, ensure_ascii=False)
        normalized = app.normalize_conversation_detail(copy.deepcopy(FIXTURE_ENVELOPE), FIXTURE_ID, raw)
        candidates = app.extract_candidates(normalized)
        first_quote = FIXTURE["transcriptions"][0]["utterances"][0]["text"]
        self.assertEqual(candidates[0]["quote"], first_quote)
        self.assertEqual(candidates[0]["action"], first_quote)
        self.assertEqual(candidates[0]["speaker"], "SPEAKER_1")
        self.assertEqual(candidates[0]["spoken_at"], 1792612800000)
        self.assertEqual(candidates[1]["category"], "proposal language")

    def test_response_id_and_schema_fail_closed(self) -> None:
        wrong = copy.deepcopy(FIXTURE_ENVELOPE)
        wrong["conversation"]["id"] += 1
        with self.assertRaises(app.AppError) as id_error:
            app.normalize_conversation_detail(wrong, FIXTURE_ID, json.dumps(wrong))
        self.assertEqual(id_error.exception.code, "bee_response_invalid")

        malformed = copy.deepcopy(FIXTURE_ENVELOPE)
        malformed["conversation"]["transcriptions"][0]["utterances"][0]["text"] = 42
        with self.assertRaises(app.AppError) as text_error:
            app.normalize_conversation_detail(malformed, FIXTURE_ID, json.dumps(malformed))
        self.assertEqual(text_error.exception.code, "bee_response_invalid")

    def test_noncompleted_record_is_not_extracted(self) -> None:
        processing = copy.deepcopy(FIXTURE_ENVELOPE)
        processing["conversation"]["state"] = "PROCESSING"
        with self.assertRaises(app.AppError) as caught:
            app.normalize_conversation_detail(processing, FIXTURE_ID, json.dumps(processing))
        self.assertEqual(caught.exception.code, "bee_conversation_not_ready")


class LocalServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bee = FakeBee()
        self.server = app.create_server(self.bee, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.origin = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path: str, *, host: str | None = None, origin: str | None = None, body: str = "{}") -> tuple[int, dict[str, Any]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(
            "POST",
            path,
            body=body,
            headers={
                "Host": host or f"127.0.0.1:{self.port}",
                "Origin": origin or self.origin,
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        result = json.loads(response.read().decode("utf-8"))
        status = response.status
        connection.close()
        return status, result

    def test_origin_and_host_guards_precede_bee_reads(self) -> None:
        wrong_host_status, _ = self.request("/api/conversations", host="outside.example")
        wrong_origin_status, _ = self.request("/api/conversations", origin="https://outside.example")
        self.assertEqual((wrong_host_status, wrong_origin_status), (421, 403))
        self.assertEqual(self.bee.calls, [])

    def test_one_conversation_flows_to_a_quote_linked_review_payload(self) -> None:
        list_status, listing = self.request("/api/conversations")
        self.assertEqual(list_status, 200)
        self.assertEqual(listing["data"]["conversations"][0]["id"], FIXTURE_ID)
        detail_status, detail = self.request("/api/conversation", body=json.dumps({"id": FIXTURE_ID}))
        self.assertEqual(detail_status, 200)
        self.assertEqual(detail["data"]["id"], FIXTURE_ID)
        self.assertEqual(detail["data"]["candidates"][0]["quote"], FIXTURE["transcriptions"][0]["utterances"][0]["text"])
        self.assertEqual(self.bee.calls, [("list", None), ("get", FIXTURE_ID)])

    def test_browser_cannot_supply_a_command_or_invalid_identifier(self) -> None:
        status, result = self.request("/api/conversation", body=json.dumps({"id": "2; whoami"}))
        self.assertEqual(status, 400)
        self.assertEqual(result["error"]["code"], "invalid_conversation_id")
        self.assertEqual(self.bee.calls, [])


if __name__ == "__main__":
    unittest.main()
