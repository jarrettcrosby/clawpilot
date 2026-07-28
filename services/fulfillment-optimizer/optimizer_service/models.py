from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


Identifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z][A-Za-z0-9._:#-]*$",
    ),
]
PositiveInt = Annotated[int, Field(strict=True, ge=1)]
NonNegativeInt = Annotated[int, Field(strict=True, ge=0)]
SafeMinor = Annotated[int, Field(strict=True, ge=0, le=1_000_000_000_000)]
DimensionMm = Annotated[int, Field(strict=True, ge=1, le=2_000_000)]
WeightGrams = Annotated[int, Field(strict=True, ge=1, le=2_000_000_000)]

FULFILLMENT_OBJECTIVE_SEQUENCE = (
    "minimize_warehouses",
    "minimize_shipments_and_cartons",
    "minimize_estimated_total_cost_minor",
    "minimize_unused_volume_mm3",
    "stable_global_id_ties",
)

ASSORTMENT_OBJECTIVE_SEQUENCE = (
    "minimize_weighted_landed_cost_minor",
    "minimize_material_sku_count",
    "minimize_weighted_waste_volume_mm3",
    "stable_global_id_ties",
)


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class StrictModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        strict=False,
        frozen=True,
    )


class DimensionsMm(StrictModel):
    length: DimensionMm
    width: DimensionMm
    height: DimensionMm

    @property
    def volume(self) -> int:
        return self.length * self.width * self.height


class OrderLineRequirement(StrictModel):
    line_global_id: Identifier
    product_global_id: Identifier
    quantity: PositiveInt
    unit_weight_grams: WeightGrams
    unit_dimensions_mm: DimensionsMm
    rotation_allowed: StrictBool
    allowed_warehouse_global_ids: tuple[Identifier, ...]
    allowed_carton_global_ids: tuple[Identifier, ...]


class InventoryCandidate(StrictModel):
    position_global_id: Identifier
    warehouse_global_id: Identifier
    product_global_id: Identifier
    available_quantity: NonNegativeInt
    unit_handling_cost_minor: SafeMinor


class WarehouseCandidateV1(StrictModel):
    warehouse_global_id: Identifier
    active: StrictBool
    handling_cost_minor: SafeMinor


class CartonCandidate(StrictModel):
    carton_global_id: Identifier
    warehouse_global_id: Identifier
    material_type: Literal["box", "poly_mailer"]
    inner_dimensions_mm: DimensionsMm
    max_weight_grams: WeightGrams
    empty_weight_grams: NonNegativeInt
    available_quantity: PositiveInt
    material_cost_minor: SafeMinor
    estimated_transport_cost_minor: SafeMinor


class FulfillmentConstraints(StrictModel):
    schema_version: Literal[1]
    max_packages: Annotated[int, Field(strict=True, ge=1, le=64)]
    max_package_weight_grams: WeightGrams | None
    allowed_warehouse_global_ids: tuple[Identifier, ...]
    allowed_carton_global_ids: tuple[Identifier, ...]


class SplitPolicy(StrictModel):
    allowed: StrictBool
    max_warehouses: Annotated[int, Field(strict=True, ge=1, le=16)]

    @model_validator(mode="after")
    def single_warehouse_when_split_disabled(self) -> "SplitPolicy":
        if not self.allowed and self.max_warehouses != 1:
            raise ValueError("maxWarehouses must equal 1 when split fulfillment is disabled")
        return self


class FulfillmentObjectivePolicy(StrictModel):
    schema_version: Literal[1]
    policy_global_id: Identifier
    sequence: tuple[str, ...]

    @model_validator(mode="after")
    def exact_objective_sequence(self) -> "FulfillmentObjectivePolicy":
        if self.sequence != FULFILLMENT_OBJECTIVE_SEQUENCE:
            raise ValueError("unsupported fulfillment objective sequence")
        return self


class FulfillmentOptimizationInput(StrictModel):
    schema_version: Literal[1]
    input_snapshot_global_id: Identifier
    organization_global_id: Identifier
    order_global_id: Identifier
    order_revision: PositiveInt
    evaluated_at_utc: str
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
    lines: tuple[OrderLineRequirement, ...]
    eligible_positions: tuple[InventoryCandidate, ...]
    warehouses: tuple[WarehouseCandidateV1, ...]
    cartons: tuple[CartonCandidate, ...]
    constraints: FulfillmentConstraints
    objective_policy: FulfillmentObjectivePolicy
    split_policy: SplitPolicy

    @model_validator(mode="after")
    def validate_snapshot_graph(self) -> "FulfillmentOptimizationInput":
        try:
            instant = datetime.fromisoformat(self.evaluated_at_utc.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("evaluatedAtUtc must be an ISO-8601 instant") from error
        if instant.tzinfo is None:
            raise ValueError("evaluatedAtUtc must include a UTC offset")
        if not self.lines:
            raise ValueError("at least one order line is required")

        def unique(values: list[str], field: str) -> None:
            if len(values) != len(set(values)):
                raise ValueError(f"{field} must contain unique stable references")

        line_ids = [item.line_global_id for item in self.lines]
        position_ids = [item.position_global_id for item in self.eligible_positions]
        warehouse_ids = [item.warehouse_global_id for item in self.warehouses]
        carton_ids = [item.carton_global_id for item in self.cartons]
        unique(line_ids, "lines")
        unique(position_ids, "eligiblePositions")
        unique(warehouse_ids, "warehouses")
        unique(carton_ids, "cartons")

        warehouse_set = set(warehouse_ids)
        carton_set = set(carton_ids)
        product_set = {item.product_global_id for item in self.lines}
        if any(item.warehouse_global_id not in warehouse_set for item in self.eligible_positions):
            raise ValueError("inventory position references an unknown warehouse")
        if any(item.product_global_id not in product_set for item in self.eligible_positions):
            raise ValueError("inventory position references an unknown product")
        if any(item.warehouse_global_id not in warehouse_set for item in self.cartons):
            raise ValueError("carton references an unknown warehouse")
        if any(item not in warehouse_set for item in self.constraints.allowed_warehouse_global_ids):
            raise ValueError("constraints reference an unknown warehouse")
        if any(item not in carton_set for item in self.constraints.allowed_carton_global_ids):
            raise ValueError("constraints reference an unknown carton")
        for line in self.lines:
            if any(item not in warehouse_set for item in line.allowed_warehouse_global_ids):
                raise ValueError("line references an unknown warehouse")
            if any(item not in carton_set for item in line.allowed_carton_global_ids):
                raise ValueError("line references an unknown carton")
        if len(self.warehouses) == 1 and self.split_policy.max_warehouses != 1:
            raise ValueError("a one-warehouse snapshot must set maxWarehouses to 1")
        return self


class OptimizerOptions(StrictModel):
    deadline_ms: Annotated[int, Field(strict=True, ge=50, le=30_000)]
    max_candidates: Annotated[int, Field(strict=True, ge=1, le=16)]


class FulfillmentOptimizationRequest(StrictModel):
    schema_version: Literal[1]
    input_hash: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    input: FulfillmentOptimizationInput
    options: OptimizerOptions


class AssortmentMaterialCandidate(StrictModel):
    material_global_id: Identifier
    material_type: Literal["box", "poly_mailer"]
    inner_dimensions_mm: DimensionsMm
    max_weight_grams: WeightGrams
    material_cost_minor: SafeMinor


class HistoricalDemandSample(StrictModel):
    sample_global_id: Identifier
    frequency: Annotated[int, Field(strict=True, ge=1, le=1_000_000)]
    packed_weight_grams: WeightGrams
    packed_volume_mm3: Annotated[int, Field(strict=True, ge=1, le=1_000_000_000_000_000)]


class FeasibleLandedCost(StrictModel):
    sample_global_id: Identifier
    material_global_id: Identifier
    landed_cost_minor: SafeMinor
    waste_volume_mm3: Annotated[int, Field(strict=True, ge=0, le=1_000_000_000_000_000)]


class AssortmentPolicy(StrictModel):
    schema_version: Literal[1]
    policy_global_id: Identifier
    max_assortment_size: Annotated[int, Field(strict=True, ge=1, le=64)]
    hard_cover_all: StrictBool
    minimum_coverage_basis_points: Annotated[int, Field(strict=True, ge=1, le=10_000)]

    @model_validator(mode="after")
    def exact_hard_cover_threshold(self) -> "AssortmentPolicy":
        if self.hard_cover_all and self.minimum_coverage_basis_points != 10_000:
            raise ValueError("hard-cover assortment policy requires 10000 basis points")
        return self


class AssortmentObjectivePolicy(StrictModel):
    schema_version: Literal[1]
    policy_global_id: Identifier
    sequence: tuple[str, ...]

    @model_validator(mode="after")
    def exact_objective_sequence(self) -> "AssortmentObjectivePolicy":
        if self.sequence != ASSORTMENT_OBJECTIVE_SEQUENCE:
            raise ValueError("unsupported assortment objective sequence")
        return self


class AssortmentOptimizationInput(StrictModel):
    schema_version: Literal[1]
    input_snapshot_global_id: Identifier
    organization_global_id: Identifier
    evaluated_at_utc: str
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
    materials: tuple[AssortmentMaterialCandidate, ...]
    demand_samples: tuple[HistoricalDemandSample, ...]
    feasible_landed_costs: tuple[FeasibleLandedCost, ...]
    policy: AssortmentPolicy
    objective_policy: AssortmentObjectivePolicy

    @model_validator(mode="after")
    def validate_assortment_graph(self) -> "AssortmentOptimizationInput":
        try:
            instant = datetime.fromisoformat(self.evaluated_at_utc.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("evaluatedAtUtc must be an ISO-8601 instant") from error
        if instant.tzinfo is None:
            raise ValueError("evaluatedAtUtc must include a UTC offset")
        material_ids = [item.material_global_id for item in self.materials]
        sample_ids = [item.sample_global_id for item in self.demand_samples]
        if not material_ids or not sample_ids:
            raise ValueError("materials and demandSamples are required")
        if len(material_ids) != len(set(material_ids)):
            raise ValueError("materials must contain unique references")
        if len(sample_ids) != len(set(sample_ids)):
            raise ValueError("demandSamples must contain unique references")
        if self.policy.max_assortment_size > len(material_ids):
            raise ValueError("maxAssortmentSize cannot exceed the material candidate count")
        material_set = set(material_ids)
        sample_set = set(sample_ids)
        option_keys: set[tuple[str, str]] = set()
        for option in self.feasible_landed_costs:
            if option.material_global_id not in material_set or option.sample_global_id not in sample_set:
                raise ValueError("feasible landed cost references an unknown sample or material")
            key = (option.sample_global_id, option.material_global_id)
            if key in option_keys:
                raise ValueError("feasible landed costs must be unique by sample and material")
            option_keys.add(key)
        return self


class AssortmentOptimizationRequest(StrictModel):
    schema_version: Literal[1]
    input_hash: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    input: AssortmentOptimizationInput
    options: OptimizerOptions
