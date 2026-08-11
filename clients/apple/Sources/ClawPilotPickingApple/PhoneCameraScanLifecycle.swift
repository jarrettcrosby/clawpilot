public struct PhoneCameraScanLifecycle: Sendable {
    public struct Token: Equatable, Sendable {
        fileprivate let generation: UInt64
    }

    public enum Phase: Equatable, Sendable {
        case active
        case submitting
        case dismissed
    }

    public private(set) var phase: Phase = .active
    private var generation: UInt64 = 0

    public init() {}

    public var isPresented: Bool {
        phase != .dismissed
    }

    public var canBeginSubmission: Bool {
        phase == .active
    }

    public func operationToken() -> Token? {
        guard isPresented else { return nil }
        return Token(generation: generation)
    }

    public func permitsCompletion(of token: Token) -> Bool {
        isPresented && token.generation == generation
    }

    public mutating func beginSubmission() -> Token? {
        guard canBeginSubmission else { return nil }
        phase = .submitting
        return Token(generation: generation)
    }

    public mutating func completeSubmission(_ token: Token) -> Bool {
        guard phase == .submitting, token.generation == generation else { return false }
        phase = .active
        return true
    }

    @discardableResult
    public mutating func dismiss() -> Bool {
        guard phase != .dismissed else { return false }
        generation &+= 1
        phase = .dismissed
        return true
    }
}
