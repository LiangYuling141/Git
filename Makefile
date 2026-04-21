.PHONY: help dev build start lint lint-fix test db-generate db-migrate db-push db-studio clean

# Development
dev: ## Start development server
	npm run dev

build: ## Build production build
	npm run build

start: ## Start production server
	npm run start

# Code Quality
lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with auto-fix
	npm run lint -- --fix

# Database (Prisma)
db-generate: ## Generate Prisma client
	npx prisma generate

db-migrate: ## Run database migrations
	npx prisma migrate dev

db-push: ## Push schema to database (without migration)
	npx prisma db push

db-studio: ## Open Prisma Studio
	npx prisma studio

# Testing
test: ## Run tests
	npm test

# Cleanup
clean: ## Remove build artifacts
	rm -rf .next
	rm -rf out
	rm -rf dist
	rm -rf build
	rm -rf node_modules/.cache

# Help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' Makefile | sort | awk 'BEGIN {FS = ":.*## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
