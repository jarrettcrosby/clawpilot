from __future__ import annotations

import copy
import os
import unittest

from fastapi.testclient import TestClient

from optimizer_service.main import app
from optimizer_service.models import (
    AssortmentOptimizationInput,
    FulfillmentOptimizationInput,
    OptimizerOptions,
)
from optimizer_service.solver import (
    canonical_sha256,
    input_payload,
    solve_assortment,
    solve_fulfillment,
)


FULFILLMENT_OBJECTIVES = [
    "minimize_warehouses",
    "minimize_shipments_and_cartons",
    "minimize_estimated_total_cost_minor",
    "minimize_unused_volume_mm3",
    "stable_global_id_ties",
]

ASSORTMENT_OBJECTIVES = [
    "minimize_weighted_landed_cost_minor",
    "minimize_material_sku_count",
    "minimize_weighted_waste_volume_mm3",
    "stable_global_id_ties",
]


def fulfillment_fixture() -> dict:
    return {
        "schemaVersion": 1,
        "inputSnapshotGlobalId": "gosi0000001",
        "organizationGlobalId": "gorg0000001",
        "orderGlobalId": "gord0000001",
        "orderRevision": 1,
        "evaluatedAtUtc": "2026-07-27T16:00:00Z",
        "currency": "USD",
        "lines": [{
            "lineGlobalId": "goln0000001",
            "productGlobalId": "gprd0000001",
            "quantity": 2,
            "unitWeightGrams": 500,
            "unitDimensionsMm": {"length": 40, "width": 80, "height": 30},
            "rotationAllowed": True,
            "allowedWarehouseGlobalIds": ["gwhs0000001"],
            "allowedCartonGlobalIds": ["gctn0000001"],
        }],
        "eligiblePositions": [{
            "positionGlobalId": "gpos0000001",
            "warehouseGlobalId": "gwhs0000001",
            "productGlobalId": "gprd0000001",
            "availableQuantity": 2,
            "unitHandlingCostMinor": 10,
        }],
        "warehouses": [{
            "warehouseGlobalId": "gwhs0000001",
            "active": True,
            "handlingCostMinor": 100,
        }],
        "cartons": [{
            "cartonGlobalId": "gctn0000001",
            "warehouseGlobalId": "gwhs0000001",
            "materialType": "box",
            "innerDimensionsMm": {"length": 100, "width": 100, "height": 80},
            "maxWeightGrams": 5_000,
            "emptyWeightGrams": 100,
            "availableQuantity": 2,
            "materialCostMinor": 25,
            "estimatedTransportCostMinor": 700,
        }],
        "constraints": {
            "schemaVersion": 1,
            "maxPackages": 2,
            "maxPackageWeightGrams": 5_000,
            "allowedWarehouseGlobalIds": ["gwhs0000001"],
            "allowedCartonGlobalIds": ["gctn0000001"],
        },
        "objectivePolicy": {
            "schemaVersion": 1,
            "policyGlobalId": "gopt0000001",
            "sequence": FULFILLMENT_OBJECTIVES,
        },
        "splitPolicy": {"allowed": False, "maxWarehouses": 1},
    }


def assortment_fixture() -> dict:
    return {
        "schemaVersion": 1,
        "inputSnapshotGlobalId": "gasi0000001",
        "organizationGlobalId": "gorg0000001",
        "evaluatedAtUtc": "2026-07-27T16:00:00Z",
        "currency": "USD",
        "materials": [
            {
                "materialGlobalId": "gmat0000001",
                "materialType": "poly_mailer",
                "innerDimensionsMm": {"length": 200, "width": 150, "height": 20},
                "maxWeightGrams": 1_000,
                "materialCostMinor": 10,
            },
            {
                "materialGlobalId": "gmat0000002",
                "materialType": "box",
                "innerDimensionsMm": {"length": 300, "width": 200, "height": 100},
                "maxWeightGrams": 5_000,
                "materialCostMinor": 25,
            },
        ],
        "demandSamples": [
            {
                "sampleGlobalId": "gdem0000001",
                "frequency": 10,
                "packedWeightGrams": 500,
                "packedVolumeMm3": 300_000,
            },
            {
                "sampleGlobalId": "gdem0000002",
                "frequency": 5,
                "packedWeightGrams": 2_000,
                "packedVolumeMm3": 3_000_000,
            },
        ],
        "feasibleLandedCosts": [
            {
                "sampleGlobalId": "gdem0000001",
                "materialGlobalId": "gmat0000001",
                "landedCostMinor": 500,
                "wasteVolumeMm3": 300_000,
            },
            {
                "sampleGlobalId": "gdem0000001",
                "materialGlobalId": "gmat0000002",
                "landedCostMinor": 500,
                "wasteVolumeMm3": 5_700_000,
            },
            {
                "sampleGlobalId": "gdem0000002",
                "materialGlobalId": "gmat0000002",
                "landedCostMinor": 800,
                "wasteVolumeMm3": 3_000_000,
            },
        ],
        "policy": {
            "schemaVersion": 1,
            "policyGlobalId": "gasp0000001",
            "maxAssortmentSize": 2,
            "hardCoverAll": True,
            "minimumCoverageBasisPoints": 10_000,
        },
        "objectivePolicy": {
            "schemaVersion": 1,
            "policyGlobalId": "gaop0000001",
            "sequence": ASSORTMENT_OBJECTIVES,
        },
    }


class FulfillmentSolverTest(unittest.TestCase):
    def test_exact_3d_cartonization_is_deterministic(self) -> None:
        value = FulfillmentOptimizationInput.model_validate(fulfillment_fixture())
        payload_hash = canonical_sha256(input_payload(value))
        options = OptimizerOptions.model_validate({
            "deadlineMs": 5_000,
            "maxCandidates": 4,
        })
        first = solve_fulfillment(value, options, payload_hash)
        second = solve_fulfillment(value, options, payload_hash)

        self.assertEqual(first["status"], "optimal")
        self.assertEqual(first["inputHash"], payload_hash)
        self.assertEqual(first["selectedPlan"], second["selectedPlan"])
        self.assertEqual(first["selectedPlan"]["warehouseGlobalIds"], ["gwhs0000001"])
        self.assertEqual(first["selectedPlan"]["cartonCount"], 1)
        package = first["selectedPlan"]["packages"][0]
        self.assertEqual(len(package["placements"]), 2)
        self.assertEqual(sum(item["quantity"] for item in package["allocations"]), 2)
        self.assertLessEqual(package["totalWeightGrams"], package["maxWeightGrams"])

    def test_single_warehouse_exact_geometry_forces_two_cartons(self) -> None:
        fixture = fulfillment_fixture()
        fixture["lines"][0]["unitDimensionsMm"] = {
            "length": 60,
            "width": 60,
            "height": 60,
        }
        value = FulfillmentOptimizationInput.model_validate(fixture)
        payload_hash = canonical_sha256(input_payload(value))
        options = OptimizerOptions.model_validate({
            "deadlineMs": 5_000,
            "maxCandidates": 2,
        })
        result = solve_fulfillment(value, options, payload_hash)

        self.assertEqual(result["status"], "optimal")
        plan = result["selectedPlan"]
        self.assertEqual(plan["warehouseGlobalIds"], ["gwhs0000001"])
        self.assertEqual(plan["warehouseCount"], 1)
        self.assertEqual(plan["shipmentCount"], 1)
        self.assertEqual(plan["cartonCount"], 2)
        self.assertEqual(plan["estimatedTotalCostMinor"], 1_570)
        self.assertEqual(plan["unusedVolumeMm3"], 1_168_000)
        self.assertEqual(len(plan["packages"]), 2)
        self.assertEqual(
            sum(
                allocation["quantity"]
                for package in plan["packages"]
                for allocation in package["allocations"]
            ),
            2,
        )
        for package in plan["packages"]:
            self.assertEqual(package["warehouseGlobalId"], "gwhs0000001")
            self.assertEqual(package["cartonGlobalId"], "gctn0000001")
            self.assertEqual(package["totalWeightGrams"], 600)
            self.assertEqual(package["usedVolumeMm3"], 216_000)
            self.assertEqual(package["unusedVolumeMm3"], 584_000)
            self.assertEqual(len(package["placements"]), 1)
            self.assertEqual(
                sum(item["quantity"] for item in package["allocations"]),
                1,
            )

    def test_split_policy_fails_closed_then_allows_explicit_split(self) -> None:
        fixture = fulfillment_fixture()
        fixture["lines"].append({
            "lineGlobalId": "goln0000002",
            "productGlobalId": "gprd0000002",
            "quantity": 1,
            "unitWeightGrams": 250,
            "unitDimensionsMm": {"length": 20, "width": 20, "height": 20},
            "rotationAllowed": False,
            "allowedWarehouseGlobalIds": ["gwhs0000002"],
            "allowedCartonGlobalIds": ["gctn0000002"],
        })
        fixture["warehouses"].append({
            "warehouseGlobalId": "gwhs0000002",
            "active": True,
            "handlingCostMinor": 100,
        })
        fixture["eligiblePositions"].append({
            "positionGlobalId": "gpos0000002",
            "warehouseGlobalId": "gwhs0000002",
            "productGlobalId": "gprd0000002",
            "availableQuantity": 1,
            "unitHandlingCostMinor": 10,
        })
        fixture["cartons"].append({
            "cartonGlobalId": "gctn0000002",
            "warehouseGlobalId": "gwhs0000002",
            "materialType": "box",
            "innerDimensionsMm": {"length": 100, "width": 100, "height": 80},
            "maxWeightGrams": 5_000,
            "emptyWeightGrams": 100,
            "availableQuantity": 1,
            "materialCostMinor": 25,
            "estimatedTransportCostMinor": 700,
        })
        fixture["constraints"]["maxPackages"] = 3
        fixture["constraints"]["allowedWarehouseGlobalIds"] = [
            "gwhs0000001",
            "gwhs0000002",
        ]
        fixture["constraints"]["allowedCartonGlobalIds"] = [
            "gctn0000001",
            "gctn0000002",
        ]
        value = FulfillmentOptimizationInput.model_validate(fixture)
        payload_hash = canonical_sha256(input_payload(value))
        options = OptimizerOptions.model_validate({"deadlineMs": 5_000, "maxCandidates": 2})
        blocked = solve_fulfillment(value, options, payload_hash)
        self.assertEqual(blocked["status"], "infeasible")

        fixture["splitPolicy"] = {"allowed": True, "maxWarehouses": 2}
        value = FulfillmentOptimizationInput.model_validate(fixture)
        payload_hash = canonical_sha256(input_payload(value))
        split = solve_fulfillment(value, options, payload_hash)
        self.assertEqual(split["status"], "optimal")
        self.assertEqual(
            split["selectedPlan"]["warehouseGlobalIds"],
            ["gwhs0000001", "gwhs0000002"],
        )
        self.assertEqual(split["selectedPlan"]["shipmentCount"], 2)


class AssortmentSolverTest(unittest.TestCase):
    def test_equal_cost_prefers_smaller_material_assortment(self) -> None:
        value = AssortmentOptimizationInput.model_validate(assortment_fixture())
        payload_hash = canonical_sha256(input_payload(value))
        options = OptimizerOptions.model_validate({"deadlineMs": 5_000, "maxCandidates": 2})
        result = solve_assortment(value, options, payload_hash)

        self.assertEqual(result["status"], "optimal")
        self.assertEqual(
            result["selectedAssortment"]["selectedMaterialGlobalIds"],
            ["gmat0000002"],
        )
        self.assertEqual(result["selectedAssortment"]["coverageBasisPoints"], 10_000)
        self.assertEqual(len(result["selectedAssortment"]["assignments"]), 2)


class HttpContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.secret = "0123456789abcdef0123456789abcdef"
        os.environ["CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET"] = self.secret
        self.client = TestClient(app)

    def tearDown(self) -> None:
        os.environ.pop("CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET", None)

    def test_authentication_and_input_hash(self) -> None:
        fixture = fulfillment_fixture()
        value = FulfillmentOptimizationInput.model_validate(fixture)
        payload_hash = canonical_sha256(input_payload(value))
        request = {
            "schemaVersion": 1,
            "inputHash": payload_hash,
            "input": fixture,
            "options": {"deadlineMs": 5_000, "maxCandidates": 2},
        }
        unauthorized = self.client.post("/v1/optimize", json=request)
        self.assertEqual(unauthorized.status_code, 401)

        invalid = copy.deepcopy(request)
        invalid["inputHash"] = "0" * 64
        mismatch = self.client.post(
            "/v1/optimize",
            json=invalid,
            headers={"Authorization": f"Bearer {self.secret}"},
        )
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(mismatch.json()["detail"]["code"], "OPTIMIZER_INPUT_HASH_MISMATCH")

        accepted = self.client.post(
            "/v1/optimize",
            json=request,
            headers={"Authorization": f"Bearer {self.secret}"},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["inputHash"], payload_hash)
        self.assertEqual(accepted.headers["cache-control"], "no-store")

    def test_assortment_endpoint(self) -> None:
        fixture = assortment_fixture()
        value = AssortmentOptimizationInput.model_validate(fixture)
        payload_hash = canonical_sha256(input_payload(value))
        response = self.client.post(
            "/v1/assortments/optimize",
            json={
                "schemaVersion": 1,
                "inputHash": payload_hash,
                "input": fixture,
                "options": {"deadlineMs": 5_000, "maxCandidates": 2},
            },
            headers={"Authorization": f"Bearer {self.secret}"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["selectedAssortment"]["selectedMaterialGlobalIds"],
            ["gmat0000002"],
        )


if __name__ == "__main__":
    unittest.main()
