#!/usr/bin/env bash
# Sets up a Google Cloud project for cloud computers (see design/cloud-computers.md): the APIs,
# the controller's and the pool VMs' service accounts, an isolated network, the pools' instance
# templates and their managed instance groups (one per size, in one zone, empty).
#
#   APP_URL=https://compass.copilotz.com scripts/cloud/setup-gcp.sh
#
# Run it again any time: each step says what it does, and skips what's there already (it looks
# first). A change to the templates' settings or to pool-startup.sh makes templates of a new
# version, and the groups roll it out. Everything it makes is named cz-*; every command names its
# resource right after its verb (`gcloud compute networks create cz-computers ...`).
#
# Settings (environment variables), with their defaults:
#   PROJECT          copilotz-485719
#   REGION           us-central1
#   ZONE             us-central1-a
#   APP_URL          https://compass.copilotz.com      what pool VMs connect to
#   RELEASE          $APP_URL/computer/download/       the computer program's release (manifest.json)
#   RUNTIME_SA       compass-runtime@$PROJECT.iam.gserviceaccount.com   the app's, acting as the controller
#   SMALL_MACHINE    e2-medium
#   STANDARD_MACHINE n2-standard-2
#   IMAGE            the pools' boot image, in this project: a disk of a Debian 12 VM that ran
#                    pool-startup.sh with metadata copilotz-image=TRUE (its tools installed);
#                    else Debian 12, which installs them at each pool VM's boot (minutes)
#   VERSION          a hash of the templates' settings and pool-startup.sh (lowercase, digits, dashes)
set -euo pipefail

PROJECT=${PROJECT:-copilotz-485719}
REGION=${REGION:-us-central1}
ZONE=${ZONE:-us-central1-a}
APP_URL=${APP_URL:-https://compass.copilotz.com}
APP_URL=${APP_URL%/}
RELEASE=${RELEASE:-$APP_URL/computer/download/}
RUNTIME_SA=${RUNTIME_SA:-compass-runtime@$PROJECT.iam.gserviceaccount.com}
SMALL_MACHINE=${SMALL_MACHINE:-e2-medium}
# Two dedicated vCPUs and 8 GB. Not N4 or C4A (as the design suggests): they take Hyperdisk only,
# and computers' disks are pd-balanced, which E2 (small) needs.
STANDARD_MACHINE=${STANDARD_MACHINE:-n2-standard-2}
IMAGE=${IMAGE:-}

CONTROLLER=cz-controller@$PROJECT.iam.gserviceaccount.com
POOL_SA=cz-pool@$PROJECT.iam.gserviceaccount.com
NETWORK=cz-computers
SUBNET=cz-computers-$REGION
RANGE=10.80.0.0/20
HERE=$(cd "$(dirname "$0")" && pwd)
STARTUP=$HERE/pool-startup.sh
SIZES="small standard"

step() { printf '\n== %s\n' "$*"; }
skip() { printf '   there already: %s\n' "$*"; }
run() {
  printf '   $'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}
quietly() { "$@" >/dev/null 2>&1; }
machine() { if [ "$1" = small ]; then echo "$SMALL_MACHINE"; else echo "$STANDARD_MACHINE"; fi; }
# A machine's boot disk: Hyperdisk for the series that take nothing else.
boot_disk() {
  case $1 in
    n4-* | c4-* | c4a-* | c4d-* | c3-* | c3d-*) echo hyperdisk-balanced ;;
    *) echo pd-balanced ;;
  esac
}
# The pools' boot image: IMAGE (this project's), else Debian 12's latest.
image_flags() {
  if [ -n "$IMAGE" ]; then
    echo "--image=$IMAGE --image-project=$PROJECT"
  else
    echo "--image-family=debian-12 --image-project=debian-cloud"
  fi
}
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
# IAM takes a few seconds to know a new service account: a binding is tried again a while.
patiently() {
  local tries=0
  until "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 6 ] || return 1
    printf '   (not yet; again in 10 s)\n'
    sleep 10
  done
}

[ -f "$STARTUP" ] || { echo "setup-gcp.sh: no $STARTUP" >&2; exit 1; }
# The templates' version: what they're made from, hashed (the same settings, the same templates).
settings() {
  printf '%s\n' "$APP_URL" "$RELEASE" "$SMALL_MACHINE" "$STANDARD_MACHINE" "$POOL_SA" "$SUBNET" \
    "$IMAGE"
  cat "$STARTUP"
}
if [ -z "${VERSION:-}" ]; then VERSION=$(settings | sha | cut -c1-8); fi

echo "Cloud computers in $PROJECT ($ZONE): app $APP_URL, templates v$VERSION"

step "APIs"
enabled=$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)')
for api in compute iamcredentials cloudbuild artifactregistry run; do
  if printf '%s\n' "$enabled" | grep -qx "$api.googleapis.com"; then
    skip "$api.googleapis.com"
  else
    run gcloud services enable "$api.googleapis.com" --project="$PROJECT"
  fi
done

step "Service accounts"
account() {
  local name=$1 title=$2
  if quietly gcloud iam service-accounts describe "$name@$PROJECT.iam.gserviceaccount.com" \
    --project="$PROJECT"; then
    skip "$name@$PROJECT.iam.gserviceaccount.com"
  else
    run gcloud iam service-accounts create "$name" --project="$PROJECT" --display-name="$title"
  fi
}
account cz-controller "Copilotz cloud computers: the controller (disks, pools)"
account cz-pool "Copilotz cloud computers: pool VMs (identity only, no roles)"

# Roles on the project, for the controller only.
project_roles=$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
  --format='csv[no-heading](bindings.role,bindings.members)')
for role in roles/compute.instanceAdmin.v1 roles/compute.storageAdmin; do
  if printf '%s\n' "$project_roles" | grep -qx "$role,serviceAccount:$CONTROLLER"; then
    skip "$role for cz-controller"
  else
    patiently run gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$CONTROLLER" --role="$role" --condition=None --quiet --format=none
  fi
done

# A role on one service account, for a member.
account_role() {
  local account=$1 member=$2 role=$3
  if gcloud iam service-accounts get-iam-policy "$account" --project="$PROJECT" \
    --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' |
    grep -qx "$role,serviceAccount:$member"; then
    skip "$role on ${account%%@*} for ${member%%@*}"
  else
    patiently run gcloud iam service-accounts add-iam-policy-binding "$account" \
      --project="$PROJECT" --member="serviceAccount:$member" --role="$role" --quiet --format=none
  fi
}
# The controller makes pool VMs (resizing their groups), which run as cz-pool.
account_role "$POOL_SA" "$CONTROLLER" roles/iam.serviceAccountUser
# The app acts as the controller (impersonation), with nothing of its own on the project.
account_role "$CONTROLLER" "$RUNTIME_SA" roles/iam.serviceAccountTokenCreator

step "Network"
if quietly gcloud compute networks describe "$NETWORK" --project="$PROJECT"; then
  skip "network $NETWORK"
else
  run gcloud compute networks create "$NETWORK" --project="$PROJECT" --subnet-mode=custom
fi
if quietly gcloud compute networks subnets describe "$SUBNET" --project="$PROJECT" \
  --region="$REGION"; then
  skip "subnet $SUBNET"
else
  run gcloud compute networks subnets create "$SUBNET" --project="$PROJECT" --region="$REGION" \
    --network="$NETWORK" --range="$RANGE"
fi

step "Firewall"
# Nothing reaches pool VMs from outside: they connect out.
if quietly gcloud compute firewall-rules describe cz-computers-deny-ingress --project="$PROJECT"; then
  skip "cz-computers-deny-ingress"
else
  run gcloud compute firewall-rules create cz-computers-deny-ingress --project="$PROJECT" \
    --network="$NETWORK" --direction=INGRESS --action=DENY --rules=all \
    --source-ranges=0.0.0.0/0 --priority=1000
fi
# Nor do they reach private addresses: other VMs, internal services. The internet they do, through
# their ephemeral external IPs (the network's implied egress rule), and the metadata server
# (169.254.169.254, link-local) too.
if quietly gcloud compute firewall-rules describe cz-computers-deny-private-egress \
  --project="$PROJECT"; then
  skip "cz-computers-deny-private-egress"
else
  run gcloud compute firewall-rules create cz-computers-deny-private-egress --project="$PROJECT" \
    --network="$NETWORK" --direction=EGRESS --action=DENY --rules=all \
    --destination-ranges=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10 --priority=900
fi

step "Instance templates (v$VERSION)"
for size in $SIZES; do
  template=cz-pool-$size-$VERSION
  type=$(machine "$size")
  if quietly gcloud compute instance-templates describe "$template" --project="$PROJECT"; then
    skip "$template"
  else
    # An ephemeral external IP (the default), cz-pool's identity with no scopes (identity tokens
    # need none), and what the startup script reads from its metadata.
    run gcloud compute instance-templates create "$template" --project="$PROJECT" \
      --machine-type="$type" \
      $(image_flags) \
      --boot-disk-size=10GB --boot-disk-type="$(boot_disk "$type")" \
      --network="projects/$PROJECT/global/networks/$NETWORK" \
      --subnet="projects/$PROJECT/regions/$REGION/subnetworks/$SUBNET" \
      --service-account="$POOL_SA" --no-scopes \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata="app-url=$APP_URL,computer-release=$RELEASE,enable-guest-attributes=TRUE" \
      --metadata-from-file="startup-script=$STARTUP" \
      --labels="app=copilotz,role=pool,size=$size,version=$VERSION"
  fi
done

step "Pools: managed instance groups in $ZONE"
for size in $SIZES; do
  group=cz-pool-$size
  template=cz-pool-$size-$VERSION
  current=$(gcloud compute instance-groups managed describe "$group" --project="$PROJECT" \
    --zone="$ZONE" --format='value(instanceTemplate.basename())' 2>/dev/null || true)
  if [ -z "$current" ]; then
    # Empty: the app sizes it. No autohealing (no health check); a zonal group has no
    # redistribution across zones (`--instance-redistribution-type` is a regional group's, and
    # gcloud refuses it for a zonal one).
    run gcloud compute instance-groups managed create "$group" --project="$PROJECT" \
      --zone="$ZONE" --template="$template" --size=0 --base-instance-name="$group"
  elif [ "$current" = "$template" ]; then
    skip "$group (on $template)"
  else
    # A new version: free VMs are replaced by ones from it (VMs taken already aren't the group's).
    run gcloud compute instance-groups managed rolling-action start-update "$group" \
      --project="$PROJECT" --zone="$ZONE" --version="template=$template" --type=proactive
  fi
done

step "Done"
echo "   The app's cloud settings: placement { project: \"$PROJECT\", zone: \"$ZONE\" },"
echo "   impersonating $CONTROLLER; pools cz-pool-small, cz-pool-standard."
