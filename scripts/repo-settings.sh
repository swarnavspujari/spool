#!/usr/bin/env bash
# Applies the GitHub repository settings that the CI and release workflows rely on.
# Safe to run again: every call sets a value, and the rulesets are updated by name.
#
# Usage: scripts/repo-settings.sh [base | rulesets | verify | all] [owner/name]
#
# Needs the GitHub CLI, logged in with admin rights on the repository.
#
# "verify" only reads. It compares each setting that "base" and "rulesets" apply with the value
# that they set, prints one line for each, and exits with 1 when any differs or cannot be read.
#
# Order for a new repository:
#   1. scripts/repo-settings.sh base       (settings, security features, immutable releases)
#   2. push main, wait for the first green "CI result"
#   3. scripts/repo-settings.sh rulesets   (the main ruleset would block that first push)
#   4. scripts/repo-settings.sh verify
# Immutable releases and the tag ruleset must exist before the first tag is pushed.
#
# The Chrome Web Store job stays off until you set the variable CWS_ENABLED to "true"; this
# script never sets it.

set -euo pipefail

command="${1:-all}"
REPO="${2:-swarnavspujari/spool}"

DESCRIPTION="Spool screenshots a whole scrolling chat or page and gets it ready for your AI. Select. Scroll. Paste."
TOPICS=(chrome-extension manifest-v3 screenshot full-page-screenshot scrolling-screenshot brave ai-vision)

# 15368 is the GitHub Actions app. Pinning it stops another app from posting a fake "CI result".
ACTIONS_APP_ID=15368
# Repository role "admin".
ADMIN_ROLE_ID=5

base() {
  echo "General settings"
  gh repo edit "$REPO" --description "$DESCRIPTION" \
    --homepage "https://github.com/$REPO#readme" \
    --enable-issues --enable-wiki=false --enable-projects=false --enable-discussions=false \
    --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
    --squash-merge-commit-message pr-title --delete-branch-on-merge --enable-auto-merge=false
  for topic in "${TOPICS[@]}"; do gh repo edit "$REPO" --add-topic "$topic"; done

  echo "Actions: GitHub-owned actions only, full-SHA pinning, read-only token"
  gh api -X PUT "repos/$REPO/actions/permissions" \
    -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
  # --input, because "gh api -f" cannot send an empty array.
  gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - <<'JSON'
{"github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": []}
JSON
  gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
  gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
    -f approval_policy=all_external_contributors
  gh api -X PUT "repos/$REPO/actions/permissions/artifact-and-log-retention" -F days=30

  echo "Security features"
  gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {
  "secret_scanning": {"status": "enabled"},
  "secret_scanning_push_protection": {"status": "enabled"}
}}
JSON
  gh api -X PUT "repos/$REPO/vulnerability-alerts"
  gh api -X PUT "repos/$REPO/automated-security-fixes"
  gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

  echo "Immutable releases"
  gh api -X PUT "repos/$REPO/immutable-releases"

  echo "Variable E2E_WORKERS (browsers per e2e job)"
  gh variable set E2E_WORKERS --repo "$REPO" --body 3
}

# Creates the ruleset with this name, or replaces its settings when it exists.
upsert_ruleset() {
  local name="$1" body="$2" id
  id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
  if [ -n "$id" ]; then
    echo "Ruleset \"$name\": update ($id)"
    printf '%s' "$body" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - > /dev/null
  else
    echo "Ruleset \"$name\": create"
    printf '%s' "$body" | gh api -X POST "repos/$REPO/rulesets" --input - > /dev/null
  fi
}

rulesets() {
  # Pull request with squash only, "CI result" must pass, no force push, no delete. Zero
  # approvals: a solo maintainer cannot approve their own pull request. Admins may bypass, but
  # only through a pull request, for the case that the CI workflow itself is broken.
  upsert_ruleset main "$(cat <<JSON
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
    } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "CI result", "integration_id": $ACTIONS_APP_ID }
        ]
    } }
  ]
}
JSON
)"

  # Only repository admins can create, move or delete a v* tag, so only they start a release.
  upsert_ruleset "release tags" "$(cat <<JSON
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ]
}
JSON
)"
}

# Differences found by verify. Each check prints one line, and a difference counts here.
differences=0
RULESET_PATH=""

# check LABEL EXPECTED COMMAND...: runs the command and compares its output with EXPECTED.
# A command that fails (for example a missing right, or a feature that is off and answers 404)
# counts as a difference.
check() {
  local label="$1" expected="$2" actual
  shift 2
  if ! actual="$("$@" 2>/dev/null)"; then actual="(could not read)"; fi
  if [ "$actual" = "$expected" ]; then
    echo "  ok    $label: $actual"
  else
    echo "  DIFF  $label: expected \"$expected\", found \"$actual\""
    differences=$((differences + 1))
  fi
}

# api_value ENDPOINT JQ: one value of a REST answer, printed by gh with the jq filter. An empty
# ENDPOINT is the repository itself.
api_value() { gh api "repos/$REPO${1:+/$1}" --jq "$2"; }

# view_value FIELD: one field of "gh repo view --json".
view_value() { gh repo view "$REPO" --json "$1" --jq ".$1"; }

# call_ok COMMAND...: prints "on" when the command succeeds, "off" when it fails. The vulnerability
# alerts endpoint answers 204 when they are on and 404 when they are off.
call_ok() { if "$@" > /dev/null 2>&1; then echo on; else echo off; fi; }

# ruleset_id NAME: the ID of the ruleset with this name, or nothing.
ruleset_id() { gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id"; }

# check_ruleset NAME TARGET REF RULE_TYPES BYPASS: compares the parts of a ruleset that matter.
# It sets RULESET_PATH to the endpoint of the ruleset (empty when there is none).
check_ruleset() {
  local name="$1" target="$2" ref="$3" types="$4" bypass="$5" id
  id="$(ruleset_id "$name" 2> /dev/null || true)"
  RULESET_PATH=""
  if [ -z "$id" ]; then
    echo "  DIFF  ruleset \"$name\": expected it to exist, found none"
    differences=$((differences + 1))
    return
  fi
  local path="rulesets/$id"
  RULESET_PATH="$path"
  check "ruleset \"$name\" target" "$target" api_value "$path" '.target'
  check "ruleset \"$name\" enforcement" active api_value "$path" '.enforcement'
  check "ruleset \"$name\" ref" "$ref" api_value "$path" '.conditions.ref_name.include | join(",")'
  check "ruleset \"$name\" rules" "$types" api_value "$path" '[.rules[].type] | sort | join(",")'
  check "ruleset \"$name\" bypass" "$bypass" \
    api_value "$path" '.bypass_actors[] | "\(.actor_type):\(.actor_id):\(.bypass_mode)"'
}

verify() {
  differences=0
  local topics
  topics="$(printf '%s\n' "${TOPICS[@]}" | sort | paste -sd, -)"

  echo "General settings"
  check "description" "$DESCRIPTION" view_value description
  check "homepage" "https://github.com/$REPO#readme" view_value homepageUrl
  check "topics" "$topics" \
    gh repo view "$REPO" --json repositoryTopics \
    --jq '[.repositoryTopics[]? | (.name // .topic.name)] | sort | join(",")'
  check "issues" true view_value hasIssuesEnabled
  check "wiki" false view_value hasWikiEnabled
  check "projects" false view_value hasProjectsEnabled
  check "discussions" false view_value hasDiscussionsEnabled
  check "squash merge" true view_value squashMergeAllowed
  check "merge commit" false view_value mergeCommitAllowed
  check "rebase merge" false view_value rebaseMergeAllowed
  check "delete branch on merge" true view_value deleteBranchOnMerge
  # "--squash-merge-commit-message pr-title" is title PR_TITLE with a blank message.
  check "squash commit title" PR_TITLE api_value '' '.squash_merge_commit_title'
  check "squash commit message" BLANK api_value '' '.squash_merge_commit_message'
  check "auto-merge" false api_value '' '.allow_auto_merge'

  echo "Actions"
  check "actions enabled" true api_value actions/permissions '.enabled'
  check "allowed actions" selected api_value actions/permissions '.allowed_actions'
  check "full-SHA pinning" true api_value actions/permissions '.sha_pinning_required'
  check "GitHub-owned actions" true \
    api_value actions/permissions/selected-actions '.github_owned_allowed'
  check "verified creators" false \
    api_value actions/permissions/selected-actions '.verified_allowed'
  check "extra action patterns" 0 \
    api_value actions/permissions/selected-actions '.patterns_allowed | length'
  check "default token" read api_value actions/permissions/workflow '.default_workflow_permissions'
  check "workflows approve pull requests" false \
    api_value actions/permissions/workflow '.can_approve_pull_request_reviews'
  check "fork pull request approval" all_external_contributors \
    api_value actions/permissions/fork-pr-contributor-approval '.approval_policy'
  check "artifact and log retention (days)" 30 \
    api_value actions/permissions/artifact-and-log-retention '.days'
  check "variable E2E_WORKERS" 3 gh variable get E2E_WORKERS --repo "$REPO"

  echo "Security features"
  check "secret scanning" enabled api_value '' '.security_and_analysis.secret_scanning.status'
  check "push protection" enabled \
    api_value '' '.security_and_analysis.secret_scanning_push_protection.status'
  check "vulnerability alerts" on call_ok gh api "repos/$REPO/vulnerability-alerts"
  check "automated security fixes" true api_value automated-security-fixes '.enabled'
  check "private vulnerability reporting" true api_value private-vulnerability-reporting '.enabled'
  check "immutable releases" true api_value immutable-releases '.enabled'

  echo "Rulesets"
  check_ruleset main branch '~DEFAULT_BRANCH' \
    'deletion,non_fast_forward,pull_request,required_linear_history,required_status_checks' \
    "RepositoryRole:$ADMIN_ROLE_ID:pull_request"
  check "ruleset \"main\" merge methods" squash \
    api_value "rulesets/$(ruleset_id main 2> /dev/null || true)" \
    '.rules[] | select(.type == "pull_request") | .parameters.allowed_merge_methods | join(",")'
  check "ruleset \"main\" required check" "CI result:$ACTIONS_APP_ID" \
    api_value "rulesets/$(ruleset_id main 2> /dev/null || true)" \
    '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | "\(.context):\(.integration_id)"'
  check_ruleset "release tags" tag 'refs/tags/v*' 'creation,deletion,update' \
    "RepositoryRole:$ADMIN_ROLE_ID:always"

  if [ "$differences" -gt 0 ]; then
    echo "$differences setting(s) differ from what this script applies." >&2
    return 1
  fi
  echo "Every setting matches."
}

case "$command" in
  base) base ;;
  rulesets) rulesets ;;
  verify) verify ;;
  all) base; rulesets; verify ;;
  *)
    echo "usage: $0 [base | rulesets | verify | all] [owner/name]" >&2
    exit 2
    ;;
esac
