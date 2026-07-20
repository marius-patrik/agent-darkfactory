.PHONY: install test lint typecheck demo serve

install:
	python -m pip install -e '.[dev]'

test:
	pytest

lint:
	ruff check src tests

typecheck:
	npm --prefix sdk/typescript run typecheck

demo:
	genesis demo --workspace .genesis/demo

serve:
	@test -n "$(LINEAGE)" || (echo "Set LINEAGE=<lineage_id>" && exit 1)
	genesis serve --workspace .genesis/default --lineage $(LINEAGE)
