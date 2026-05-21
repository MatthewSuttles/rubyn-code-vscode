module Admin
  class User < ApplicationRecord
    self.table_name = "admin_users"

    has_many :audit_logs
    scope :superusers, -> { where(role: "superuser") }

    class << self
      def with_role(role)
        where(role: role)
      end
    end
  end
end
