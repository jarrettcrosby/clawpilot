from __future__ import annotations

import hashlib
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

from ortools.sat.python import cp_model

from .models import (
    AssortmentOptimizationInput,
    FulfillmentOptimizationInput,
    OptimizerOptions,
)


ORTOOLS_VERSION = "9.15.6755"
FULFILLMENT_ALGORITHM_VERSION = (
    f"clawpilot-fulfillment-cpsat-3d-v1+ortools-{ORTOOLS_VERSION}"
)
ASSORTMENT_ALGORITHM_VERSION = (
    f"clawpilot-material-assortment-cpsat-v1+ortools-{ORTOOLS_VERSION}"
)

MAX_LINES = 100
MAX_UNITS = 80
MAX_POSITIONS = 256
MAX_WAREHOUSES = 16
MAX_CARTON_TYPES = 64
MAX_CARTON_SLOTS = 64
MAX_ASSIGNMENT_VARIABLES = 50_000
MAX_PAIRWISE_DISJUNCTIONS = 250_000
MAX_ASSORTMENT_MATERIALS = 128
MAX_ASSORTMENT_SAMPLES = 512
MAX_ASSORTMENT_OPTIONS = 16_384
MAX_CANONICAL_BODY_BYTES = 1_048_576


class OptimizerBoundError(ValueError):
    """The immutable request exceeds the bounded solver contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def input_payload(value: FulfillmentOptimizationInput | AssortmentOptimizationInput) -> dict[str, Any]:
    return value.model_dump(mode="json", by_alias=True)


def unique_rotations(length: int, width: int, height: int, allowed: bool) -> tuple[tuple[int, int, int], ...]:
    if not allowed:
        return ((length, width, height),)
    return tuple(sorted({
        (length, width, height),
        (length, height, width),
        (width, length, height),
        (width, height, length),
        (height, length, width),
        (height, width, length),
    }))


def dimensions_fit(
    rotations: Iterable[tuple[int, int, int]],
    length: int,
    width: int,
    height: int,
) -> bool:
    return any(
        item_length <= length
        and item_width <= width
        and item_height <= height
        for item_length, item_width, item_height in rotations
    )


@dataclass(frozen=True)
class Unit:
    index: int
    unit_key: str
    line_global_id: str
    product_global_id: str
    weight_grams: int
    volume_mm3: int
    rotations: tuple[tuple[int, int, int], ...]
    allowed_warehouse_global_ids: frozenset[str]
    allowed_carton_global_ids: frozenset[str]


@dataclass(frozen=True)
class CartonSlot:
    index: int
    slot_number: int
    package_key: str
    carton_global_id: str
    warehouse_global_id: str
    length_mm: int
    width_mm: int
    height_mm: int
    max_weight_grams: int
    empty_weight_grams: int
    material_cost_minor: int
    estimated_transport_cost_minor: int

    @property
    def volume_mm3(self) -> int:
        return self.length_mm * self.width_mm * self.height_mm


def bounded_fulfillment_input(value: FulfillmentOptimizationInput) -> tuple[list[Unit], list[CartonSlot]]:
    if len(value.lines) > MAX_LINES:
        raise OptimizerBoundError(f"lines exceeds {MAX_LINES}")
    if len(value.eligible_positions) > MAX_POSITIONS:
        raise OptimizerBoundError(f"eligiblePositions exceeds {MAX_POSITIONS}")
    if len(value.warehouses) > MAX_WAREHOUSES:
        raise OptimizerBoundError(f"warehouses exceeds {MAX_WAREHOUSES}")
    if len(value.cartons) > MAX_CARTON_TYPES:
        raise OptimizerBoundError(f"cartons exceeds {MAX_CARTON_TYPES}")

    total_units = sum(item.quantity for item in value.lines)
    if total_units > MAX_UNITS:
        raise OptimizerBoundError(
            f"expanded unit quantity exceeds {MAX_UNITS}; aggregate or partition the immutable order"
        )
    units: list[Unit] = []
    for line in sorted(value.lines, key=lambda item: item.line_global_id):
        rotations = unique_rotations(
            line.unit_dimensions_mm.length,
            line.unit_dimensions_mm.width,
            line.unit_dimensions_mm.height,
            line.rotation_allowed,
        )
        volume = line.unit_dimensions_mm.volume
        if volume > 1_000_000_000_000_000:
            raise OptimizerBoundError("unit volume exceeds integer model bounds")
        for unit_number in range(1, line.quantity + 1):
            units.append(Unit(
                index=len(units),
                unit_key=f"{line.line_global_id}#{unit_number:06d}",
                line_global_id=line.line_global_id,
                product_global_id=line.product_global_id,
                weight_grams=line.unit_weight_grams,
                volume_mm3=volume,
                rotations=rotations,
                allowed_warehouse_global_ids=frozenset(line.allowed_warehouse_global_ids),
                allowed_carton_global_ids=frozenset(line.allowed_carton_global_ids),
            ))
    constraint_warehouses = frozenset(value.constraints.allowed_warehouse_global_ids)
    constraint_cartons = frozenset(value.constraints.allowed_carton_global_ids)
    active_warehouses = {
        item.warehouse_global_id
        for item in value.warehouses
        if item.active
        and (not constraint_warehouses or item.warehouse_global_id in constraint_warehouses)
    }
    eligible_cartons = [
        carton
        for carton in sorted(value.cartons, key=lambda item: item.carton_global_id)
        if carton.warehouse_global_id in active_warehouses
        and (not constraint_cartons or carton.carton_global_id in constraint_cartons)
    ]
    candidate_slot_count = sum(
        min(carton.available_quantity, value.constraints.max_packages)
        for carton in eligible_cartons
    )
    if candidate_slot_count > MAX_CARTON_SLOTS:
        raise OptimizerBoundError(
            f"candidate carton slots exceeds {MAX_CARTON_SLOTS}; preselect a bounded immutable catalog"
        )
    slots: list[CartonSlot] = []
    for carton in eligible_cartons:
        volume = carton.inner_dimensions_mm.volume
        if volume > 1_000_000_000_000_000:
            raise OptimizerBoundError("carton volume exceeds integer model bounds")
        slot_count = min(
            carton.available_quantity,
            value.constraints.max_packages,
        )
        for slot_number in range(1, slot_count + 1):
            max_weight = carton.max_weight_grams
            if value.constraints.max_package_weight_grams is not None:
                max_weight = min(max_weight, value.constraints.max_package_weight_grams)
            slots.append(CartonSlot(
                index=len(slots),
                slot_number=slot_number,
                package_key=f"{carton.carton_global_id}#{slot_number:04d}",
                carton_global_id=carton.carton_global_id,
                warehouse_global_id=carton.warehouse_global_id,
                length_mm=carton.inner_dimensions_mm.length,
                width_mm=carton.inner_dimensions_mm.width,
                height_mm=carton.inner_dimensions_mm.height,
                max_weight_grams=max_weight,
                empty_weight_grams=carton.empty_weight_grams,
                material_cost_minor=carton.material_cost_minor,
                estimated_transport_cost_minor=carton.estimated_transport_cost_minor,
            ))
    return units, slots


class FulfillmentModel:
    def __init__(self, value: FulfillmentOptimizationInput) -> None:
        self.input = value
        self.units, self.slots = bounded_fulfillment_input(value)
        self.model = cp_model.CpModel()
        self.positions = sorted(
            [
                item
                for item in value.eligible_positions
                if item.available_quantity > 0
            ],
            key=lambda item: item.position_global_id,
        )
        self.warehouses = sorted(
            [
                item
                for item in value.warehouses
                if item.active
                and (
                    not value.constraints.allowed_warehouse_global_ids
                    or item.warehouse_global_id in value.constraints.allowed_warehouse_global_ids
                )
            ],
            key=lambda item: item.warehouse_global_id,
        )
        self.assignment: dict[tuple[int, int, int], cp_model.IntVar] = {}
        self.unit_bin: dict[tuple[int, int], cp_model.IntVar] = {}
        self.bin_used: dict[int, cp_model.IntVar] = {}
        self.warehouse_used: dict[str, cp_model.IntVar] = {}
        self.orientation: dict[int, cp_model.IntVar] = {}
        self.dim_x: dict[int, cp_model.IntVar] = {}
        self.dim_y: dict[int, cp_model.IntVar] = {}
        self.dim_z: dict[int, cp_model.IntVar] = {}
        self.coord_x: dict[int, cp_model.IntVar] = {}
        self.coord_y: dict[int, cp_model.IntVar] = {}
        self.coord_z: dict[int, cp_model.IntVar] = {}
        self.compatible_positions_by_unit: dict[int, list[int]] = defaultdict(list)
        self.compatible_bins_by_unit: dict[int, list[int]] = defaultdict(list)
        self._build()

    def _build(self) -> None:
        model = self.model
        if not self.units or not self.slots:
            model.add(0 == 1)
            return

        position_by_index = {index: item for index, item in enumerate(self.positions)}
        slot_by_index = {item.index: item for item in self.slots}
        max_dimension = max(
            max(item.length_mm, item.width_mm, item.height_mm)
            for item in self.slots
        )

        for slot in self.slots:
            self.bin_used[slot.index] = model.new_bool_var(f"bin_used_{slot.index}")
        for warehouse in self.warehouses:
            self.warehouse_used[warehouse.warehouse_global_id] = model.new_bool_var(
                f"warehouse_used_{warehouse.warehouse_global_id}"
            )

        assignment_count = 0
        for unit in self.units:
            orientation_count = len(unit.rotations)
            self.orientation[unit.index] = model.new_int_var(
                0,
                orientation_count - 1,
                f"orientation_{unit.index}",
            )
            x_values = [item[0] for item in unit.rotations]
            y_values = [item[1] for item in unit.rotations]
            z_values = [item[2] for item in unit.rotations]
            self.dim_x[unit.index] = model.new_int_var(
                min(x_values), max(x_values), f"dim_x_{unit.index}"
            )
            self.dim_y[unit.index] = model.new_int_var(
                min(y_values), max(y_values), f"dim_y_{unit.index}"
            )
            self.dim_z[unit.index] = model.new_int_var(
                min(z_values), max(z_values), f"dim_z_{unit.index}"
            )
            model.add_element(self.orientation[unit.index], x_values, self.dim_x[unit.index])
            model.add_element(self.orientation[unit.index], y_values, self.dim_y[unit.index])
            model.add_element(self.orientation[unit.index], z_values, self.dim_z[unit.index])
            self.coord_x[unit.index] = model.new_int_var(0, max_dimension, f"coord_x_{unit.index}")
            self.coord_y[unit.index] = model.new_int_var(0, max_dimension, f"coord_y_{unit.index}")
            self.coord_z[unit.index] = model.new_int_var(0, max_dimension, f"coord_z_{unit.index}")

            compatible_position_indices = [
                position_index
                for position_index, position in position_by_index.items()
                if position.product_global_id == unit.product_global_id
                and (
                    not unit.allowed_warehouse_global_ids
                    or position.warehouse_global_id in unit.allowed_warehouse_global_ids
                )
            ]
            self.compatible_positions_by_unit[unit.index] = compatible_position_indices

            assignment_for_unit: list[cp_model.IntVar] = []
            for slot in self.slots:
                if (
                    unit.allowed_carton_global_ids
                    and slot.carton_global_id not in unit.allowed_carton_global_ids
                ):
                    continue
                if (
                    unit.allowed_warehouse_global_ids
                    and slot.warehouse_global_id not in unit.allowed_warehouse_global_ids
                ):
                    continue
                if unit.weight_grams + slot.empty_weight_grams > slot.max_weight_grams:
                    continue
                if not dimensions_fit(
                    unit.rotations,
                    slot.length_mm,
                    slot.width_mm,
                    slot.height_mm,
                ):
                    continue
                position_indices = [
                    position_index
                    for position_index in compatible_position_indices
                    if position_by_index[position_index].warehouse_global_id == slot.warehouse_global_id
                ]
                if not position_indices:
                    continue
                unit_bin = model.new_bool_var(f"unit_{unit.index}_bin_{slot.index}")
                self.unit_bin[(unit.index, slot.index)] = unit_bin
                self.compatible_bins_by_unit[unit.index].append(slot.index)
                assignments_for_bin: list[cp_model.IntVar] = []
                for position_index in position_indices:
                    variable = model.new_bool_var(
                        f"assign_{unit.index}_{position_index}_{slot.index}"
                    )
                    self.assignment[(unit.index, position_index, slot.index)] = variable
                    assignments_for_bin.append(variable)
                    assignment_for_unit.append(variable)
                    assignment_count += 1
                    if assignment_count > MAX_ASSIGNMENT_VARIABLES:
                        raise OptimizerBoundError(
                            f"compatible inventory/carton assignments exceed {MAX_ASSIGNMENT_VARIABLES}"
                        )
                model.add(unit_bin == sum(assignments_for_bin))
                model.add(unit_bin <= self.bin_used[slot.index])
                model.add(
                    self.coord_x[unit.index] + self.dim_x[unit.index] <= slot.length_mm
                ).only_enforce_if(unit_bin)
                model.add(
                    self.coord_y[unit.index] + self.dim_y[unit.index] <= slot.width_mm
                ).only_enforce_if(unit_bin)
                model.add(
                    self.coord_z[unit.index] + self.dim_z[unit.index] <= slot.height_mm
                ).only_enforce_if(unit_bin)
            if not assignment_for_unit:
                model.add(0 == 1)
            else:
                model.add(sum(assignment_for_unit) == 1)

        for position_index, position in position_by_index.items():
            variables = [
                variable
                for (unit_index, candidate_position_index, _), variable in self.assignment.items()
                if candidate_position_index == position_index
            ]
            if variables:
                model.add(sum(variables) <= position.available_quantity)

        for slot in self.slots:
            unit_variables = [
                variable
                for (unit_index, slot_index), variable in self.unit_bin.items()
                if slot_index == slot.index
            ]
            if unit_variables:
                for variable in unit_variables:
                    model.add(variable <= self.bin_used[slot.index])
                model.add(self.bin_used[slot.index] <= sum(unit_variables))
                model.add(
                    sum(
                        self.units[unit_index].weight_grams * variable
                        for (unit_index, slot_index), variable in self.unit_bin.items()
                        if slot_index == slot.index
                    )
                    + slot.empty_weight_grams * self.bin_used[slot.index]
                    <= slot.max_weight_grams
                )
                model.add(
                    sum(
                        self.units[unit_index].volume_mm3 * variable
                        for (unit_index, slot_index), variable in self.unit_bin.items()
                        if slot_index == slot.index
                    )
                    <= slot.volume_mm3
                )
            else:
                model.add(self.bin_used[slot.index] == 0)

        for warehouse in self.warehouses:
            bins = [
                self.bin_used[slot.index]
                for slot in self.slots
                if slot.warehouse_global_id == warehouse.warehouse_global_id
            ]
            if bins:
                for variable in bins:
                    model.add(variable <= self.warehouse_used[warehouse.warehouse_global_id])
                model.add(self.warehouse_used[warehouse.warehouse_global_id] <= sum(bins))
            else:
                model.add(self.warehouse_used[warehouse.warehouse_global_id] == 0)

        warehouse_limit = (
            self.input.split_policy.max_warehouses
            if self.input.split_policy.allowed
            else 1
        )
        model.add(sum(self.warehouse_used.values()) <= warehouse_limit)
        model.add(sum(self.bin_used.values()) <= self.input.constraints.max_packages)

        pairwise_count = 0
        for left_index in range(len(self.units)):
            for right_index in range(left_index + 1, len(self.units)):
                common_bins = sorted(
                    set(self.compatible_bins_by_unit[left_index])
                    & set(self.compatible_bins_by_unit[right_index])
                )
                for slot_index in common_bins:
                    left_in_bin = self.unit_bin[(left_index, slot_index)]
                    right_in_bin = self.unit_bin[(right_index, slot_index)]
                    directions = [
                        model.new_bool_var(
                            f"separate_{left_index}_{right_index}_{slot_index}_{direction}"
                        )
                        for direction in range(6)
                    ]
                    for direction in directions:
                        model.add(direction <= left_in_bin)
                        model.add(direction <= right_in_bin)
                    model.add(sum(directions) >= left_in_bin + right_in_bin - 1)
                    model.add(
                        self.coord_x[left_index] + self.dim_x[left_index]
                        <= self.coord_x[right_index]
                    ).only_enforce_if(directions[0])
                    model.add(
                        self.coord_x[right_index] + self.dim_x[right_index]
                        <= self.coord_x[left_index]
                    ).only_enforce_if(directions[1])
                    model.add(
                        self.coord_y[left_index] + self.dim_y[left_index]
                        <= self.coord_y[right_index]
                    ).only_enforce_if(directions[2])
                    model.add(
                        self.coord_y[right_index] + self.dim_y[right_index]
                        <= self.coord_y[left_index]
                    ).only_enforce_if(directions[3])
                    model.add(
                        self.coord_z[left_index] + self.dim_z[left_index]
                        <= self.coord_z[right_index]
                    ).only_enforce_if(directions[4])
                    model.add(
                        self.coord_z[right_index] + self.dim_z[right_index]
                        <= self.coord_z[left_index]
                    ).only_enforce_if(directions[5])
                    pairwise_count += 1
        if pairwise_count > MAX_PAIRWISE_DISJUNCTIONS:
            raise OptimizerBoundError(
                f"3D pairwise disjunctions exceed {MAX_PAIRWISE_DISJUNCTIONS}"
            )

    @property
    def warehouse_count(self) -> cp_model.LinearExpr:
        return sum(self.warehouse_used.values())

    @property
    def carton_count(self) -> cp_model.LinearExpr:
        return sum(self.bin_used.values())

    @property
    def total_cost_minor(self) -> cp_model.LinearExpr:
        warehouse_cost = sum(
            warehouse.handling_cost_minor * self.warehouse_used[warehouse.warehouse_global_id]
            for warehouse in self.warehouses
        )
        carton_cost = sum(
            (slot.material_cost_minor + slot.estimated_transport_cost_minor)
            * self.bin_used[slot.index]
            for slot in self.slots
        )
        position_cost = sum(
            self.positions[position_index].unit_handling_cost_minor * variable
            for (_, position_index, _), variable in self.assignment.items()
        )
        return warehouse_cost + carton_cost + position_cost

    @property
    def unused_volume_mm3(self) -> cp_model.LinearExpr:
        used_volume = sum(item.volume_mm3 for item in self.units)
        return sum(
            slot.volume_mm3 * self.bin_used[slot.index]
            for slot in self.slots
        ) - used_volume

    @property
    def stable_tie(self) -> cp_model.LinearExpr:
        warehouse_terms = sum(
            (index + 1) * self.warehouse_used[item.warehouse_global_id]
            for index, item in enumerate(self.warehouses)
        )
        bin_terms = sum(
            (index + 1) * self.bin_used[item.index]
            for index, item in enumerate(self.slots)
        )
        assignment_terms = sum(
            (
                (unit_index + 1) * (len(self.positions) + 1) * (len(self.slots) + 1)
                + (position_index + 1) * (len(self.slots) + 1)
                + slot_index + 1
            ) * variable
            for (unit_index, position_index, slot_index), variable in self.assignment.items()
        )
        return warehouse_terms + bin_terms + assignment_terms

    def extract_plan(self, solver: cp_model.CpSolver) -> dict[str, Any]:
        position_by_index = {index: item for index, item in enumerate(self.positions)}
        warehouse_by_id = {item.warehouse_global_id: item for item in self.warehouses}
        packages: list[dict[str, Any]] = []
        total_cost = 0
        used_warehouses: set[str] = set()
        total_unused_volume = 0

        for slot in self.slots:
            if solver.value(self.bin_used[slot.index]) != 1:
                continue
            used_warehouses.add(slot.warehouse_global_id)
            placements: list[dict[str, Any]] = []
            allocation_counts: dict[tuple[str, str, str], int] = defaultdict(int)
            position_cost = 0
            used_volume = 0
            item_weight = 0
            for unit in self.units:
                unit_bin = self.unit_bin.get((unit.index, slot.index))
                if unit_bin is None or solver.value(unit_bin) != 1:
                    continue
                selected_position_index = next(
                    position_index
                    for (unit_index, position_index, slot_index), variable in self.assignment.items()
                    if unit_index == unit.index
                    and slot_index == slot.index
                    and solver.value(variable) == 1
                )
                position = position_by_index[selected_position_index]
                dimensions = {
                    "length": solver.value(self.dim_x[unit.index]),
                    "width": solver.value(self.dim_y[unit.index]),
                    "height": solver.value(self.dim_z[unit.index]),
                }
                coordinates = {
                    "x": solver.value(self.coord_x[unit.index]),
                    "y": solver.value(self.coord_y[unit.index]),
                    "z": solver.value(self.coord_z[unit.index]),
                }
                placements.append({
                    "unitKey": unit.unit_key,
                    "lineGlobalId": unit.line_global_id,
                    "productGlobalId": unit.product_global_id,
                    "positionGlobalId": position.position_global_id,
                    "dimensionsMm": dimensions,
                    "coordinatesMm": coordinates,
                })
                allocation_counts[
                    (unit.line_global_id, unit.product_global_id, position.position_global_id)
                ] += 1
                position_cost += position.unit_handling_cost_minor
                used_volume += unit.volume_mm3
                item_weight += unit.weight_grams
            placements.sort(key=lambda item: item["unitKey"])
            allocations = [
                {
                    "lineGlobalId": line_global_id,
                    "productGlobalId": product_global_id,
                    "positionGlobalId": position_global_id,
                    "quantity": quantity,
                }
                for (
                    line_global_id,
                    product_global_id,
                    position_global_id,
                ), quantity in sorted(allocation_counts.items())
            ]
            package_cost = (
                slot.material_cost_minor
                + slot.estimated_transport_cost_minor
                + position_cost
            )
            package = {
                "packageKey": slot.package_key,
                "warehouseGlobalId": slot.warehouse_global_id,
                "cartonGlobalId": slot.carton_global_id,
                "innerDimensionsMm": {
                    "length": slot.length_mm,
                    "width": slot.width_mm,
                    "height": slot.height_mm,
                },
                "maxWeightGrams": slot.max_weight_grams,
                "emptyWeightGrams": slot.empty_weight_grams,
                "totalWeightGrams": slot.empty_weight_grams + item_weight,
                "usedVolumeMm3": used_volume,
                "unusedVolumeMm3": slot.volume_mm3 - used_volume,
                "estimatedCostMinor": package_cost,
                "allocations": allocations,
                "placements": placements,
            }
            packages.append(package)
            total_cost += package_cost
            total_unused_volume += package["unusedVolumeMm3"]

        packages.sort(key=lambda item: item["packageKey"])
        for warehouse_global_id in used_warehouses:
            total_cost += warehouse_by_id[warehouse_global_id].handling_cost_minor
        raw_plan = {
            "warehouseGlobalIds": sorted(used_warehouses),
            "warehouseCount": len(used_warehouses),
            "shipmentCount": len(used_warehouses),
            "cartonCount": len(packages),
            "estimatedTotalCostMinor": total_cost,
            "unusedVolumeMm3": total_unused_volume,
            "packages": packages,
        }
        return {
            "planId": f"plan-{canonical_sha256(raw_plan)[:20]}",
            **raw_plan,
        }


def configured_solver(remaining_seconds: float) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.001, remaining_seconds)
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.log_search_progress = False
    solver.parameters.cp_model_presolve = True
    return solver


def fulfillment_result(
    *,
    input_hash: str,
    started: float,
    status: str,
    selected_plan: dict[str, Any] | None,
    stage_results: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
) -> dict[str, Any]:
    duration_ms = max(0, round((time.perf_counter() - started) * 1000))
    return {
        "schemaVersion": 1,
        "status": status,
        "method": "or_tools",
        "algorithmVersion": FULFILLMENT_ALGORITHM_VERSION,
        "inputHash": input_hash,
        "durationMs": duration_ms,
        "selectedPlan": selected_plan,
        "candidates": [selected_plan] if selected_plan is not None else [],
        "rejectedAlternatives": rejected,
        "fallbackReason": None,
        "explanation": [
            {
                "code": "ORTOOLS_LEXICOGRAPHIC_STAGE",
                "facts": item,
            }
            for item in stage_results
        ],
    }


def solve_fulfillment(
    value: FulfillmentOptimizationInput,
    options: OptimizerOptions,
    input_hash: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    deadline = started + options.deadline_ms / 1000
    stage_results: list[dict[str, Any]] = []
    try:
        formulation = FulfillmentModel(value)
    except OptimizerBoundError:
        raise

    stages = [
        ("minimize_warehouses", formulation.warehouse_count),
        ("minimize_shipments_and_cartons", formulation.carton_count),
        ("minimize_estimated_total_cost_minor", formulation.total_cost_minor),
        ("minimize_unused_volume_mm3", formulation.unused_volume_mm3),
        ("stable_global_id_ties", formulation.stable_tie),
    ]
    selected_plan: dict[str, Any] | None = None

    for stage_name, objective in stages:
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            return fulfillment_result(
                input_hash=input_hash,
                started=started,
                status="feasible" if selected_plan is not None else "timeout",
                selected_plan=selected_plan,
                stage_results=stage_results,
                rejected=[],
            )
        formulation.model.minimize(objective)
        solver = configured_solver(remaining)
        solver_status = solver.solve(formulation.model)
        if solver_status == cp_model.INFEASIBLE:
            return fulfillment_result(
                input_hash=input_hash,
                started=started,
                status="infeasible",
                selected_plan=None,
                stage_results=stage_results,
                rejected=[{
                    "code": "NO_HARD_CONSTRAINT_FEASIBLE_PLAN",
                    "details": {
                        "lineCount": len(value.lines),
                        "expandedUnitCount": len(formulation.units),
                        "eligiblePositionCount": len(formulation.positions),
                        "candidateCartonSlotCount": len(formulation.slots),
                    },
                }],
            )
        if solver_status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return fulfillment_result(
                input_hash=input_hash,
                started=started,
                status="feasible" if selected_plan is not None else "timeout",
                selected_plan=selected_plan,
                stage_results=stage_results,
                rejected=[],
            )
        selected_plan = formulation.extract_plan(solver)
        objective_value = int(round(solver.objective_value))
        stage_results.append({
            "stage": stage_name,
            "status": "optimal" if solver_status == cp_model.OPTIMAL else "feasible",
            "objectiveValue": objective_value,
        })
        if solver_status != cp_model.OPTIMAL:
            return fulfillment_result(
                input_hash=input_hash,
                started=started,
                status="feasible",
                selected_plan=selected_plan,
                stage_results=stage_results,
                rejected=[],
            )
        formulation.model.add(objective == objective_value)

    return fulfillment_result(
        input_hash=input_hash,
        started=started,
        status="optimal",
        selected_plan=selected_plan,
        stage_results=stage_results,
        rejected=[],
    )


def bounded_assortment_input(value: AssortmentOptimizationInput) -> None:
    if len(value.materials) > MAX_ASSORTMENT_MATERIALS:
        raise OptimizerBoundError(f"materials exceeds {MAX_ASSORTMENT_MATERIALS}")
    if len(value.demand_samples) > MAX_ASSORTMENT_SAMPLES:
        raise OptimizerBoundError(f"demandSamples exceeds {MAX_ASSORTMENT_SAMPLES}")
    if len(value.feasible_landed_costs) > MAX_ASSORTMENT_OPTIONS:
        raise OptimizerBoundError(f"feasibleLandedCosts exceeds {MAX_ASSORTMENT_OPTIONS}")
    frequency_by_sample = {
        item.sample_global_id: item.frequency
        for item in value.demand_samples
    }
    weighted_cost_bound = sum(
        frequency_by_sample[item.sample_global_id] * item.landed_cost_minor
        for item in value.feasible_landed_costs
    )
    weighted_waste_bound = sum(
        frequency_by_sample[item.sample_global_id] * item.waste_volume_mm3
        for item in value.feasible_landed_costs
    )
    if weighted_cost_bound > 8_000_000_000_000_000_000:
        raise OptimizerBoundError("weighted landed cost exceeds integer model bounds")
    if weighted_waste_bound > 8_000_000_000_000_000_000:
        raise OptimizerBoundError("weighted waste exceeds integer model bounds")


def solve_assortment(
    value: AssortmentOptimizationInput,
    options: OptimizerOptions,
    input_hash: str,
) -> dict[str, Any]:
    bounded_assortment_input(value)
    started = time.perf_counter()
    deadline = started + options.deadline_ms / 1000
    model = cp_model.CpModel()
    materials = sorted(value.materials, key=lambda item: item.material_global_id)
    samples = sorted(value.demand_samples, key=lambda item: item.sample_global_id)
    options_by_key = {
        (item.sample_global_id, item.material_global_id): item
        for item in value.feasible_landed_costs
    }
    selected = {
        material.material_global_id: model.new_bool_var(
            f"material_{material.material_global_id}"
        )
        for material in materials
    }
    assigned: dict[tuple[str, str], cp_model.IntVar] = {}
    covered: dict[str, cp_model.IntVar] = {}
    for sample in samples:
        choices: list[cp_model.IntVar] = []
        for material in materials:
            key = (sample.sample_global_id, material.material_global_id)
            option = options_by_key.get(key)
            if option is None:
                continue
            variable = model.new_bool_var(
                f"assign_{sample.sample_global_id}_{material.material_global_id}"
            )
            assigned[key] = variable
            model.add(variable <= selected[material.material_global_id])
            choices.append(variable)
        covered[sample.sample_global_id] = model.new_bool_var(
            f"covered_{sample.sample_global_id}"
        )
        model.add(covered[sample.sample_global_id] == sum(choices))
        if value.policy.hard_cover_all:
            model.add(covered[sample.sample_global_id] == 1)

    for material in materials:
        uses = [
            variable
            for (sample_id, material_id), variable in assigned.items()
            if material_id == material.material_global_id
        ]
        if uses:
            for variable in uses:
                model.add(variable <= selected[material.material_global_id])
            model.add(selected[material.material_global_id] <= sum(uses))
        else:
            model.add(selected[material.material_global_id] == 0)
    model.add(sum(selected.values()) <= value.policy.max_assortment_size)

    total_frequency = sum(item.frequency for item in samples)
    required_frequency = math.ceil(
        total_frequency * value.policy.minimum_coverage_basis_points / 10_000
    )
    model.add(
        sum(
            sample.frequency * covered[sample.sample_global_id]
            for sample in samples
        )
        >= required_frequency
    )

    frequency_by_sample = {
        item.sample_global_id: item.frequency
        for item in samples
    }
    weighted_cost = sum(
        frequency_by_sample[sample_id]
        * options_by_key[(sample_id, material_id)].landed_cost_minor
        * variable
        for (sample_id, material_id), variable in assigned.items()
    )
    material_count = sum(selected.values())
    weighted_waste = sum(
        frequency_by_sample[sample_id]
        * options_by_key[(sample_id, material_id)].waste_volume_mm3
        * variable
        for (sample_id, material_id), variable in assigned.items()
    )
    stable_tie = (
        sum(
            (index + 1) * selected[item.material_global_id]
            for index, item in enumerate(materials)
        )
        + sum(
            (
                (sample_index + 1) * (len(materials) + 1)
                + material_index
                + 1
            ) * assigned[(sample.sample_global_id, material.material_global_id)]
            for sample_index, sample in enumerate(samples)
            for material_index, material in enumerate(materials)
            if (sample.sample_global_id, material.material_global_id) in assigned
        )
    )
    stages = [
        ("minimize_weighted_landed_cost_minor", weighted_cost),
        ("minimize_material_sku_count", material_count),
        ("minimize_weighted_waste_volume_mm3", weighted_waste),
        ("stable_global_id_ties", stable_tie),
    ]
    stage_results: list[dict[str, Any]] = []
    last_solution: dict[str, Any] | None = None

    def extract(solver: cp_model.CpSolver) -> dict[str, Any]:
        selected_ids = sorted(
            material_id
            for material_id, variable in selected.items()
            if solver.value(variable) == 1
        )
        assignments = []
        for sample in samples:
            for material in materials:
                key = (sample.sample_global_id, material.material_global_id)
                variable = assigned.get(key)
                if variable is None or solver.value(variable) != 1:
                    continue
                option = options_by_key[key]
                assignments.append({
                    "sampleGlobalId": sample.sample_global_id,
                    "materialGlobalId": material.material_global_id,
                    "frequency": sample.frequency,
                    "landedCostMinor": option.landed_cost_minor,
                    "wasteVolumeMm3": option.waste_volume_mm3,
                })
        assignments.sort(key=lambda item: item["sampleGlobalId"])
        uncovered = sorted(
            sample.sample_global_id
            for sample in samples
            if solver.value(covered[sample.sample_global_id]) == 0
        )
        covered_frequency = sum(
            item.frequency
            for item in samples
            if solver.value(covered[item.sample_global_id]) == 1
        )
        return {
            "selectedMaterialGlobalIds": selected_ids,
            "assignments": assignments,
            "uncoveredSampleGlobalIds": uncovered,
            "coveredFrequency": covered_frequency,
            "totalFrequency": total_frequency,
            "coverageBasisPoints": (covered_frequency * 10_000) // total_frequency,
            "weightedLandedCostMinor": sum(
                item["frequency"] * item["landedCostMinor"]
                for item in assignments
            ),
            "weightedWasteVolumeMm3": sum(
                item["frequency"] * item["wasteVolumeMm3"]
                for item in assignments
            ),
        }

    def result(status: str, solution: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "status": status,
            "method": "or_tools",
            "algorithmVersion": ASSORTMENT_ALGORITHM_VERSION,
            "inputHash": input_hash,
            "durationMs": max(0, round((time.perf_counter() - started) * 1000)),
            "selectedAssortment": solution,
            "fallbackReason": None,
            "explanation": [
                {"code": "ORTOOLS_LEXICOGRAPHIC_STAGE", "facts": item}
                for item in stage_results
            ],
        }

    for stage_name, objective in stages:
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            return result("feasible" if last_solution is not None else "timeout", last_solution)
        model.minimize(objective)
        solver = configured_solver(remaining)
        solver_status = solver.solve(model)
        if solver_status == cp_model.INFEASIBLE:
            return result("infeasible", None)
        if solver_status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return result("feasible" if last_solution is not None else "timeout", last_solution)
        last_solution = extract(solver)
        objective_value = int(round(solver.objective_value))
        stage_results.append({
            "stage": stage_name,
            "status": "optimal" if solver_status == cp_model.OPTIMAL else "feasible",
            "objectiveValue": objective_value,
        })
        if solver_status != cp_model.OPTIMAL:
            return result("feasible", last_solution)
        model.add(objective == objective_value)
    return result("optimal", last_solution)
